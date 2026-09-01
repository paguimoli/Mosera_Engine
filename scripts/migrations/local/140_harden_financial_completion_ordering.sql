-- Preserve causal Ledger-before-Wallet validation without relying on wall-clock
-- ordering for an explicit Ledger no-op.
do $migration$
declare
  v_definition text;
  v_repaired_definition text;
  v_repaired_block constant text := $repaired$
if v_ledger_attempt.status = 'Posted'
       and (v_ledger.completed_at is null or v_wallet_result.completed_at is null
            or v_ledger.completed_at > v_wallet_result.completed_at) then
      raise exception 'Wallet completion cannot precede authoritative Ledger completion.';
    end if;
$repaired$;
begin
  select pg_get_functiondef(
    'ticket_completion_authority.complete_ticket(uuid,jsonb,text,text,text,text)'::regprocedure
  ) into v_definition;

  v_repaired_definition := regexp_replace(
    v_definition,
    $pattern$if[[:space:]]+v_ledger_attempt\.created_at[[:space:]]*>[[:space:]]*v_wallet_attempt\.created_at[[:space:]]+or[[:space:]]+\(v_ledger\.completed_at[[:space:]]+is[[:space:]]+not[[:space:]]+null[[:space:]]+and[[:space:]]+v_wallet_result\.completed_at[[:space:]]+is[[:space:]]+not[[:space:]]+null[[:space:]]+and[[:space:]]+v_ledger\.completed_at[[:space:]]*>[[:space:]]*v_wallet_result\.completed_at\)[[:space:]]+then[[:space:]]+raise[[:space:]]+exception[[:space:]]+'Wallet completion cannot precede authoritative Ledger completion\.';[[:space:]]+end[[:space:]]+if;$pattern$,
    v_repaired_block
  );
  if v_repaired_definition = v_definition then
    raise exception 'Financial completion ordering migration made no change.';
  end if;

  execute v_repaired_definition;
end;
$migration$;

comment on function ticket_completion_authority.complete_ticket(uuid, jsonb, text, text, text, text) is
  'Canonical immutable ticket completion authority. Requires exact Settlement, causal Ledger instruction, Wallet, and per-item evidence; a Ledger no-op is ordered by immutable instruction sequence rather than cross-transaction timestamps.';
