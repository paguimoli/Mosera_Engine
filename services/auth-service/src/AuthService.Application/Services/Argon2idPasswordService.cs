using System.Security.Cryptography;
using System.Text;
using Konscious.Security.Cryptography;

namespace AuthService.Application.Services;

public sealed class Argon2idPasswordService
{
    public int MemoryCostKiB { get; } = ReadInt("AUTH_ARGON2_MEMORY_KIB", 65_536, 32_768, 1_048_576);
    public int Iterations { get; } = ReadInt("AUTH_ARGON2_ITERATIONS", 3, 2, 20);
    public int Parallelism { get; } = ReadInt("AUTH_ARGON2_PARALLELISM", 1, 1, 16);
    public int SaltLength { get; } = 16;
    public int HashLength { get; } = 32;

    public IReadOnlyCollection<string> ValidatePassword(string password, string? username = null, string? email = null)
    {
        var errors = new List<string>();
        if (password.Length < 12) errors.Add("password_too_short");
        if (password.Length > 128) errors.Add("password_too_long");
        if (!password.Any(char.IsUpper)) errors.Add("password_requires_uppercase");
        if (!password.Any(char.IsLower)) errors.Add("password_requires_lowercase");
        if (!password.Any(char.IsDigit)) errors.Add("password_requires_digit");
        if (!password.Any(character => !char.IsLetterOrDigit(character))) errors.Add("password_requires_symbol");
        if (!string.IsNullOrWhiteSpace(username) && password.Contains(username, StringComparison.OrdinalIgnoreCase)) errors.Add("password_contains_username");
        var emailLocalPart = email?.Split('@', 2)[0];
        if (!string.IsNullOrWhiteSpace(emailLocalPart) && emailLocalPart.Length >= 3 && password.Contains(emailLocalPart, StringComparison.OrdinalIgnoreCase)) errors.Add("password_contains_email");
        return errors;
    }

    public async Task<string> HashAsync(string password, CancellationToken cancellationToken = default)
    {
        var salt = RandomNumberGenerator.GetBytes(SaltLength);
        var hash = await DeriveAsync(password, salt, MemoryCostKiB, Iterations, Parallelism, HashLength, cancellationToken);
        return $"$argon2id$v=19$m={MemoryCostKiB},t={Iterations},p={Parallelism}${Convert.ToBase64String(salt)}${Convert.ToBase64String(hash)}";
    }

    public async Task<bool> VerifyAsync(string password, string encodedHash, CancellationToken cancellationToken = default)
    {
        if (!TryParse(encodedHash, out var memory, out var iterations, out var parallelism, out var salt, out var expected)) return false;
        var actual = await DeriveAsync(password, salt, memory, iterations, parallelism, expected.Length, cancellationToken);
        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }

    private static async Task<byte[]> DeriveAsync(string password, byte[] salt, int memory, int iterations, int parallelism, int hashLength, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var argon2 = new Argon2id(Encoding.UTF8.GetBytes(password))
        {
            Salt = salt,
            MemorySize = memory,
            Iterations = iterations,
            DegreeOfParallelism = parallelism
        };
        return await argon2.GetBytesAsync(hashLength);
    }

    private static bool TryParse(string value, out int memory, out int iterations, out int parallelism, out byte[] salt, out byte[] hash)
    {
        memory = iterations = parallelism = 0;
        salt = hash = [];
        try
        {
            var parts = value.Split('$', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length != 5 || parts[0] != "argon2id" || parts[1] != "v=19") return false;
            var parameters = parts[2].Split(',').Select(item => item.Split('=', 2)).ToDictionary(item => item[0], item => int.Parse(item[1], System.Globalization.CultureInfo.InvariantCulture));
            memory = parameters["m"];
            iterations = parameters["t"];
            parallelism = parameters["p"];
            salt = Convert.FromBase64String(parts[3]);
            hash = Convert.FromBase64String(parts[4]);
            return memory >= 32_768 && iterations >= 2 && parallelism >= 1 && salt.Length >= 16 && hash.Length >= 32;
        }
        catch
        {
            return false;
        }
    }

    private static int ReadInt(string name, int fallback, int minimum, int maximum)
    {
        var raw = Environment.GetEnvironmentVariable(name);
        return int.TryParse(raw, out var value) && value >= minimum && value <= maximum ? value : fallback;
    }
}
