using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public sealed class OutcomeOperationalControlService
{
    private static readonly IReadOnlyDictionary<OutcomeCustodyState, OutcomeCustodyState[]> AllowedTransitions =
        new Dictionary<OutcomeCustodyState, OutcomeCustodyState[]>
        {
            [OutcomeCustodyState.Generated] =
            [
                OutcomeCustodyState.Sealed,
                OutcomeCustodyState.Certified,
                OutcomeCustodyState.Voided,
                OutcomeCustodyState.Disputed
            ],
            [OutcomeCustodyState.Sealed] =
            [
                OutcomeCustodyState.Certified,
                OutcomeCustodyState.Voided,
                OutcomeCustodyState.Disputed
            ],
            [OutcomeCustodyState.Certified] =
            [
                OutcomeCustodyState.Superseded,
                OutcomeCustodyState.Voided,
                OutcomeCustodyState.Disputed
            ],
            [OutcomeCustodyState.Disputed] =
            [
                OutcomeCustodyState.Sealed,
                OutcomeCustodyState.Certified,
                OutcomeCustodyState.Superseded,
                OutcomeCustodyState.Voided
            ]
        };

    public OutcomeCustodyTransitionResult ValidateTransition(
        OutcomeCustodyState? fromState,
        OutcomeCustodyState toState,
        OutcomeOperationalControl? control)
    {
        var errors = new List<string>();

        if (fromState is null)
        {
            if (toState != OutcomeCustodyState.Generated)
            {
                errors.Add("Initial custody event must enter Generated state.");
            }

            return new OutcomeCustodyTransitionResult(errors.Count == 0, errors);
        }

        if (!AllowedTransitions.TryGetValue(fromState.Value, out var allowed) || !allowed.Contains(toState))
        {
            errors.Add($"Custody transition {fromState.Value} -> {toState} is not allowed.");
        }

        if (toState == OutcomeCustodyState.Superseded &&
            control?.ControlType != OutcomeOperationalControlType.OutcomeSupersede)
        {
            errors.Add("Supersession custody events require an OUTCOME_SUPERSEDE control.");
        }

        if (toState == OutcomeCustodyState.Voided &&
            control?.ControlType != OutcomeOperationalControlType.OutcomeVoid)
        {
            errors.Add("Voiding custody events require an OUTCOME_VOID control.");
        }

        if (toState == OutcomeCustodyState.Disputed &&
            control?.ControlType != OutcomeOperationalControlType.OutcomeDispute)
        {
            errors.Add("Dispute custody events require an OUTCOME_DISPUTE control.");
        }

        return new OutcomeCustodyTransitionResult(errors.Count == 0, errors);
    }

    public IReadOnlyCollection<string> ValidateControl(OutcomeOperationalControl control)
    {
        var errors = new List<string>();

        if (control.ProductionAffecting)
        {
            if (control.DualApprovalStatus != DualApprovalStatus.Approved)
            {
                errors.Add("Production-affecting outcome controls require dual approval.");
            }

            if (string.IsNullOrWhiteSpace(control.ApprovedBy))
            {
                errors.Add("Production-affecting outcome controls require an approver.");
            }

            if (string.Equals(control.RequestedBy, control.ApprovedBy, StringComparison.OrdinalIgnoreCase))
            {
                errors.Add("Requester and approver must be different principals.");
            }
        }

        if (control.ControlType == OutcomeOperationalControlType.EmergencyDisable &&
            control.ExpiresAt is null &&
            control.RenewedByControlId is null)
        {
            errors.Add("Emergency disable controls must be time-bound or explicitly renewed.");
        }

        if (control.ControlType == OutcomeOperationalControlType.OutcomeSupersede &&
            control.OriginalOutcomeCertificateId is null)
        {
            errors.Add("Outcome supersession must reference the original outcome certificate.");
        }

        if ((control.ControlType == OutcomeOperationalControlType.OutcomeVoid ||
             control.ControlType == OutcomeOperationalControlType.OutcomeReplay) &&
            control.AuditEvidence.Count == 0)
        {
            errors.Add("Void and replay controls must include audit evidence.");
        }

        return errors;
    }
}
