using System.Reflection;
using GameEngine.Domain.Model;
using GameEngine.Domain.Modules;
using GameEngine.Modules.HotSpot;
using GameEngine.Modules.TestModule;

namespace GameEngine.Application.Services;

public sealed class GameModuleRegistry
{
    private readonly DateTimeOffset loadedAt = DateTimeOffset.UtcNow;
    private readonly List<GameModuleRegistryEntry> registeredModules = [];
    private readonly List<GameModuleRegistryEntry> rejectedModules = [];
    private readonly List<GameBinding> gameBindings = [];

    public GameModuleRegistry()
    {
        DiscoverModules();
        SeedProspectiveBindings();
    }

    public IReadOnlyCollection<GameModuleRegistryEntry> GetRegisteredModules() => registeredModules.ToArray();

    public IReadOnlyCollection<GameModuleRegistryEntry> GetRejectedModules() => rejectedModules.ToArray();

    public IReadOnlyCollection<GameModuleRegistryEntry> GetActiveModules()
    {
        return registeredModules
            .Where(module => module.LifecycleStatus is GameModuleLifecycleStatus.Approved or GameModuleLifecycleStatus.ProductionActive)
            .ToArray();
    }

    public IReadOnlyCollection<GameModuleRegistryEntry> GetInactiveModules()
    {
        return registeredModules
            .Where(module => module.LifecycleStatus is not (GameModuleLifecycleStatus.Approved or GameModuleLifecycleStatus.ProductionActive))
            .ToArray();
    }

    public IReadOnlyCollection<GameModuleRegistryEntry> GetProductionReadyModules()
    {
        return registeredModules.Where(module => module.ProductionReady).ToArray();
    }

    public GameModuleRegistryEntry? GetModule(string moduleId)
    {
        return registeredModules
            .Concat(rejectedModules)
            .FirstOrDefault(module => string.Equals(module.ModuleId, moduleId, StringComparison.OrdinalIgnoreCase));
    }

    public IReadOnlyCollection<GameModuleRegistryEntry> GetModuleVersions(string moduleId)
    {
        return registeredModules
            .Concat(rejectedModules)
            .Where(module => string.Equals(module.ModuleId, moduleId, StringComparison.OrdinalIgnoreCase))
            .OrderBy(module => module.ModuleVersion, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    public IReadOnlyCollection<GameBinding> GetGameBindings() => gameBindings.ToArray();

    public GameBinding? GetGameBinding(Guid id)
    {
        return gameBindings.FirstOrDefault(binding => binding.Id == id);
    }

    public GameModuleRegistryStatus GetRegistryStatus()
    {
        var reasons = new List<string>();
        if (rejectedModules.Count > 0)
        {
            reasons.Add("One or more modules were rejected during startup discovery.");
        }

        if (registeredModules.Count == 0)
        {
            reasons.Add("No valid game modules are registered.");
        }

        if (registeredModules.All(module => !module.ProductionReady))
        {
            reasons.Add("No registered module is production ready.");
        }

        var health = registeredModules.Count == 0
            ? GameModuleRegistryHealth.Error
            : rejectedModules.Count > 0 || registeredModules.All(module => !module.ProductionReady)
                ? GameModuleRegistryHealth.Warning
                : GameModuleRegistryHealth.Healthy;

        return new GameModuleRegistryStatus(
            health,
            registeredModules.Count,
            rejectedModules.Count,
            GetActiveModules().Count,
            GetInactiveModules().Count,
            GetProductionReadyModules().Count,
            reasons,
            DateTimeOffset.UtcNow);
    }

    public GameBinding CreateProspectiveBinding(GameBindingRequest request)
    {
        var module = SelectModuleVersion(request);
        var validation = ValidateBindingConfiguration(request, module);
        var bindingId = Guid.NewGuid();
        var versionId = Guid.NewGuid();
        var status = validation.IsValid ? GameBindingStatus.Validated : GameBindingStatus.Rejected;
        var configurationHash = $"{request.ModuleId}:{module?.ModuleVersion ?? "missing"}:{request.GameCode}:{request.DrawAuthority}:{request.DrawSchedule}".ToUpperInvariant();

        var version = new GameBindingVersion(
            versionId,
            bindingId,
            request.ModuleId,
            module?.ModuleVersion ?? request.SpecificModuleVersion ?? string.Empty,
            request.DrawAuthority,
            request.DrawSchedule,
            request.SettlementTriggerPolicy,
            request.VersionSelectionMode,
            request.DefaultConfiguration,
            request.GameConfigurationOverrides,
            configurationHash,
            status,
            validation,
            DateTimeOffset.UtcNow,
            null,
            DateTimeOffset.UtcNow);

        var binding = new GameBinding(
            bindingId,
            request.GameCode,
            request.DisplayName,
            request.GameType,
            request.WagerType,
            versionId,
            [version],
            DateTimeOffset.UtcNow);

        gameBindings.Add(binding);
        return binding;
    }

    private void DiscoverModules()
    {
        _ = typeof(HotSpotModule).Assembly;
        _ = typeof(TestGameModule).Assembly;

        var moduleTypes = AppDomain.CurrentDomain
            .GetAssemblies()
            .Where(assembly => !assembly.IsDynamic)
            .SelectMany(SafeGetTypes)
            .Where(type => typeof(IGameModule).IsAssignableFrom(type)
                && type is { IsAbstract: false, IsInterface: false }
                && type.GetConstructor(Type.EmptyTypes) is not null)
            .OrderBy(type => type.FullName, StringComparer.Ordinal)
            .ToArray();

        foreach (var type in moduleTypes)
        {
            RegisterModuleType(type);
        }
    }

    private void RegisterModuleType(Type type)
    {
        try
        {
            var instance = Activator.CreateInstance(type);
            if (instance is not IGameModule module)
            {
                rejectedModules.Add(BuildRejectedEntry(type, "unknown", "unknown", "Type does not implement IGameModule."));
                return;
            }

            var entry = ValidateModule(module, type.Assembly.GetName().Name ?? type.Assembly.FullName ?? type.FullName ?? "unknown");
            AddEntry(entry);
        }
        catch (Exception ex)
        {
            rejectedModules.Add(BuildRejectedEntry(type, "unknown", "unknown", $"Module construction failed: {ex.Message}"));
        }
    }

    private GameModuleRegistryEntry ValidateModule(IGameModule module, string assemblyName)
    {
        var errors = new List<ValidationError>();
        var warnings = new List<ValidationWarning>();
        GameModuleManifest? manifest = null;
        GameModuleVersionMetadata? metadata = null;
        GameModuleHealthCheckResult? health = null;
        GameModuleLifecycleGateResult? gate = null;
        var configurationValidator = module as IGameConfigurationValidator;
        var ticketValidator = module as IGameTicketValidator;
        var drawGenerator = module as IGameDrawGenerator;
        var evaluator = module as IGameEvaluator;
        var healthCheck = module as IGameModuleHealthCheck;
        var fixtureProvider = module as IGameModuleFixtureProvider;

        try
        {
            manifest = module.GetManifest();
        }
        catch (Exception ex)
        {
            errors.Add(new ValidationError(ValidationCode.InvalidConfiguration, "manifest", $"Manifest could not be read: {ex.Message}", ValidationSeverity.Error));
        }

        try
        {
            metadata = module.GetVersionMetadata();
        }
        catch (Exception ex)
        {
            errors.Add(new ValidationError(ValidationCode.InvalidConfiguration, "versionMetadata", $"Version metadata could not be read: {ex.Message}", ValidationSeverity.Error));
        }

        if (configurationValidator is null)
        {
            errors.Add(new ValidationError(ValidationCode.InvalidConfiguration, "sdk.configuration", "Module must implement IGameConfigurationValidator.", ValidationSeverity.Error));
        }

        if (ticketValidator is null)
        {
            errors.Add(new ValidationError(ValidationCode.InvalidConfiguration, "sdk.ticketValidator", "Module must implement IGameTicketValidator.", ValidationSeverity.Error));
        }

        if (drawGenerator is null)
        {
            errors.Add(new ValidationError(ValidationCode.InvalidConfiguration, "sdk.drawGenerator", "Module must implement IGameDrawGenerator.", ValidationSeverity.Error));
        }

        if (evaluator is null)
        {
            errors.Add(new ValidationError(ValidationCode.InvalidConfiguration, "sdk.evaluator", "Module must implement IGameEvaluator.", ValidationSeverity.Error));
        }

        if (healthCheck is null)
        {
            errors.Add(new ValidationError(ValidationCode.InvalidConfiguration, "sdk.health", "Module must implement IGameModuleHealthCheck.", ValidationSeverity.Error));
        }
        else
        {
            health = healthCheck.HealthCheck();
            if (health.Status is GameModuleHealthStatus.Unhealthy or GameModuleHealthStatus.Unknown)
            {
                errors.Add(new ValidationError(ValidationCode.InvalidConfiguration, "health", "Module health check is not healthy enough for registration.", ValidationSeverity.Error));
            }
        }

        if (fixtureProvider is null)
        {
            errors.Add(new ValidationError(ValidationCode.InvalidConfiguration, "sdk.fixtures", "Module must implement IGameModuleFixtureProvider.", ValidationSeverity.Error));
        }

        if (manifest is null)
        {
            errors.Add(new ValidationError(ValidationCode.InvalidConfiguration, "manifest", "Manifest is required.", ValidationSeverity.Error));
        }
        else
        {
            ValidateManifest(manifest, metadata, errors, warnings);
        }

        if (errors.Count == 0
            && configurationValidator is not null
            && ticketValidator is not null
            && drawGenerator is not null
            && evaluator is not null
            && healthCheck is not null
            && fixtureProvider is not null)
        {
            var configuration = configurationValidator.ValidateConfiguration(new Dictionary<string, object?>());
            if (!configuration.Accepted || !configuration.Validation.IsValid)
            {
                errors.AddRange(configuration.Validation.Errors);
            }

            gate = GameModuleLifecycleGate.Evaluate(module, configurationValidator, ticketValidator, evaluator, healthCheck, fixtureProvider);
            warnings.AddRange(gate.Warnings.Select(warning => new ValidationWarning(ValidationCode.None, "lifecycleGate", warning)));
        }

        var validation = errors.Count == 0
            ? ValidationResult.Success(warnings)
            : new ValidationResult(false, errors, warnings);
        var registrationStatus = errors.Count == 0
            ? GameModuleRegistrationStatus.Registered
            : GameModuleRegistrationStatus.Rejected;
        var manifestValue = manifest ?? EmptyManifest(module.ModuleId);
        var productionReady = gate?.ProductionReady ?? false;

        return new GameModuleRegistryEntry(
            manifestValue.ModuleId,
            manifestValue.ModuleName,
            manifestValue.ModuleVersion,
            manifestValue.LifecycleStatus,
            manifestValue.GameTypes,
            manifestValue.SupportedWagerTypes,
            manifestValue.SupportedDrawAuthorityTypes,
            manifestValue.SupportsInternalDrawGeneration,
            manifestValue.ConfigurationSchemaVersion,
            health?.Status ?? GameModuleHealthStatus.Unknown,
            ToApprovalStatus(manifestValue.LifecycleStatus),
            productionReady,
            assemblyName,
            loadedAt,
            registrationStatus,
            validation,
            gate?.Blockers ?? [],
            gate?.Warnings ?? []);
    }

    private void AddEntry(GameModuleRegistryEntry entry)
    {
        var duplicate = registeredModules
            .Concat(rejectedModules)
            .FirstOrDefault(existing => string.Equals(existing.ModuleId, entry.ModuleId, StringComparison.OrdinalIgnoreCase)
                && string.Equals(existing.ModuleVersion, entry.ModuleVersion, StringComparison.OrdinalIgnoreCase));

        if (duplicate is not null)
        {
            var duplicateEntry = entry with
            {
                RegistrationStatus = GameModuleRegistrationStatus.Rejected,
                Validation = new ValidationResult(false, [
                    new ValidationError(
                        ValidationCode.InvalidConfiguration,
                        "module.version",
                        $"Duplicate module id/version detected for {entry.ModuleId} {entry.ModuleVersion}.",
                        ValidationSeverity.Error)
                ], entry.Validation.Warnings)
            };
            rejectedModules.Add(duplicateEntry);
            return;
        }

        if (entry.RegistrationStatus == GameModuleRegistrationStatus.Registered)
        {
            registeredModules.Add(entry);
        }
        else
        {
            rejectedModules.Add(entry);
        }
    }

    private GameModuleRegistryEntry? SelectModuleVersion(GameBindingRequest request)
    {
        var candidates = registeredModules
            .Where(module => string.Equals(module.ModuleId, request.ModuleId, StringComparison.OrdinalIgnoreCase))
            .ToArray();

        return request.VersionSelectionMode switch
        {
            GameModuleVersionSelectionMode.SpecificVersion => candidates.FirstOrDefault(module =>
                string.Equals(module.ModuleVersion, request.SpecificModuleVersion, StringComparison.OrdinalIgnoreCase)),
            GameModuleVersionSelectionMode.LatestApproved => candidates
                .Where(module => module.ApprovalStatus is GameModuleApprovalStatus.Approved or GameModuleApprovalStatus.ProductionApproved)
                .OrderByDescending(module => module.ModuleVersion, StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault() ?? candidates.OrderByDescending(module => module.ModuleVersion, StringComparer.OrdinalIgnoreCase).FirstOrDefault(),
            _ => candidates.OrderByDescending(module => module.ModuleVersion, StringComparer.OrdinalIgnoreCase).FirstOrDefault()
        };
    }

    private ValidationResult ValidateBindingConfiguration(GameBindingRequest request, GameModuleRegistryEntry? module)
    {
        var errors = new List<ValidationError>();
        var warnings = new List<ValidationWarning>();

        if (module is null)
        {
            errors.Add(new ValidationError(ValidationCode.InvalidConfiguration, "moduleId", "Requested module version is not registered.", ValidationSeverity.Error));
            return new ValidationResult(false, errors, warnings);
        }

        if (!module.SupportedGameTypes.Contains(request.GameType))
        {
            errors.Add(new ValidationError(ValidationCode.UnsupportedGameType, "gameType", "Binding game type is not supported by module.", ValidationSeverity.Error));
        }

        if (!module.SupportedWagerTypes.Contains(request.WagerType))
        {
            errors.Add(new ValidationError(ValidationCode.UnsupportedWagerType, "wagerType", "Binding wager type is not supported by module.", ValidationSeverity.Error));
        }

        if (!module.SupportedDrawAuthorities.Contains(request.DrawAuthority))
        {
            errors.Add(new ValidationError(ValidationCode.InvalidConfiguration, "drawAuthority", "Binding draw authority is not supported by module.", ValidationSeverity.Error));
        }

        if (string.IsNullOrWhiteSpace(request.DrawSchedule))
        {
            errors.Add(new ValidationError(ValidationCode.InvalidConfiguration, "drawSchedule", "Draw schedule is required.", ValidationSeverity.Error));
        }

        if (!module.ProductionReady)
        {
            warnings.Add(new ValidationWarning(ValidationCode.None, "module", "Binding is prospective; module is not production-ready."));
        }

        return errors.Count == 0 ? ValidationResult.Success(warnings) : new ValidationResult(false, errors, warnings);
    }

    private void SeedProspectiveBindings()
    {
        foreach (var module in registeredModules)
        {
            if (module.SupportedGameTypes.Count == 0 || module.SupportedWagerTypes.Count == 0 || module.SupportedDrawAuthorities.Count == 0)
            {
                continue;
            }

            CreateProspectiveBinding(new GameBindingRequest(
                $"{module.ModuleId.ToLowerInvariant().Replace("_", "-")}-prospective",
                $"{module.ModuleName} Prospective Binding",
                module.SupportedGameTypes.First(),
                module.SupportedWagerTypes.First(),
                module.ModuleId,
                GameModuleVersionSelectionMode.SpecificVersion,
                module.ModuleVersion,
                module.SupportedDrawAuthorities.First(),
                "manual-qa-schedule",
                SettlementTriggerPolicy.Manual,
                new Dictionary<string, object?>(),
                new Dictionary<string, object?>()));
        }
    }

    private static void ValidateManifest(
        GameModuleManifest manifest,
        GameModuleVersionMetadata? metadata,
        List<ValidationError> errors,
        List<ValidationWarning> warnings)
    {
        if (string.IsNullOrWhiteSpace(manifest.ModuleId))
        {
            errors.Add(new ValidationError(ValidationCode.InvalidConfiguration, "manifest.moduleId", "Module id is required.", ValidationSeverity.Error));
        }

        if (string.IsNullOrWhiteSpace(manifest.ModuleVersion))
        {
            errors.Add(new ValidationError(ValidationCode.InvalidConfiguration, "manifest.moduleVersion", "Module version is required.", ValidationSeverity.Error));
        }

        if (manifest.GameTypes.Count == 0)
        {
            errors.Add(new ValidationError(ValidationCode.InvalidConfiguration, "manifest.gameTypes", "At least one game type is required.", ValidationSeverity.Error));
        }

        if (manifest.SupportedWagerTypes.Count == 0)
        {
            errors.Add(new ValidationError(ValidationCode.InvalidConfiguration, "manifest.supportedWagerTypes", "At least one wager type is required.", ValidationSeverity.Error));
        }

        if (manifest.SupportedDrawAuthorityTypes.Count == 0)
        {
            errors.Add(new ValidationError(ValidationCode.InvalidConfiguration, "manifest.supportedDrawAuthorityTypes", "At least one draw authority is required.", ValidationSeverity.Error));
        }

        if (string.IsNullOrWhiteSpace(manifest.ConfigurationSchemaVersion))
        {
            errors.Add(new ValidationError(ValidationCode.InvalidConfiguration, "manifest.configurationSchemaVersion", "Configuration schema version is required.", ValidationSeverity.Error));
        }

        if (string.IsNullOrWhiteSpace(manifest.Checksum))
        {
            errors.Add(new ValidationError(ValidationCode.InvalidConfiguration, "manifest.checksum", "Manifest checksum is required.", ValidationSeverity.Error));
        }

        if (metadata is null)
        {
            errors.Add(new ValidationError(ValidationCode.InvalidConfiguration, "versionMetadata", "Version metadata is required.", ValidationSeverity.Error));
            return;
        }

        if (!string.Equals(metadata.ModuleVersion, manifest.ModuleVersion, StringComparison.OrdinalIgnoreCase))
        {
            errors.Add(new ValidationError(ValidationCode.InvalidConfiguration, "versionMetadata.moduleVersion", "Version metadata must match manifest version.", ValidationSeverity.Error));
        }

        if (!string.Equals(metadata.ConfigurationSchemaVersion, manifest.ConfigurationSchemaVersion, StringComparison.OrdinalIgnoreCase))
        {
            errors.Add(new ValidationError(ValidationCode.InvalidConfiguration, "versionMetadata.configurationSchemaVersion", "Version metadata must match configuration schema version.", ValidationSeverity.Error));
        }

        if (manifest.LifecycleStatus is GameModuleLifecycleStatus.Development or GameModuleLifecycleStatus.InternalTesting)
        {
            warnings.Add(new ValidationWarning(ValidationCode.None, "manifest.lifecycleStatus", "Module is registered but not production-approved."));
        }
    }

    private static IEnumerable<Type> SafeGetTypes(Assembly assembly)
    {
        try
        {
            return assembly.GetTypes();
        }
        catch (ReflectionTypeLoadException ex)
        {
            return ex.Types.Where(type => type is not null)!;
        }
    }

    private static GameModuleApprovalStatus ToApprovalStatus(GameModuleLifecycleStatus status)
    {
        return status switch
        {
            GameModuleLifecycleStatus.Approved => GameModuleApprovalStatus.Approved,
            GameModuleLifecycleStatus.ProductionActive => GameModuleApprovalStatus.ProductionApproved,
            _ => GameModuleApprovalStatus.NotApproved
        };
    }

    private static GameModuleManifest EmptyManifest(string moduleId)
    {
        return new GameModuleManifest(
            moduleId,
            "Invalid Module",
            string.Empty,
            [],
            [],
            [],
            false,
            false,
            false,
            string.Empty,
            string.Empty,
            string.Empty,
            string.Empty,
            GameModuleLifecycleStatus.Development,
            string.Empty,
            DateTimeOffset.UnixEpoch,
            string.Empty);
    }

    private static GameModuleRegistryEntry BuildRejectedEntry(Type type, string moduleId, string moduleVersion, string message)
    {
        var manifest = EmptyManifest(moduleId == "unknown" ? type.Name : moduleId) with { ModuleVersion = moduleVersion };
        return new GameModuleRegistryEntry(
            manifest.ModuleId,
            manifest.ModuleName,
            manifest.ModuleVersion,
            manifest.LifecycleStatus,
            [],
            [],
            [],
            false,
            string.Empty,
            GameModuleHealthStatus.Unknown,
            GameModuleApprovalStatus.NotApproved,
            false,
            type.Assembly.GetName().Name ?? type.Assembly.FullName ?? type.FullName ?? "unknown",
            DateTimeOffset.UtcNow,
            GameModuleRegistrationStatus.Rejected,
            new ValidationResult(false, [
                new ValidationError(ValidationCode.InvalidConfiguration, "module", message, ValidationSeverity.Error)
            ], []),
            [],
            []);
    }
}
