alter table public.authority_approval_records
  drop constraint if exists authority_approval_records_type_check;

alter table public.authority_approval_records
  add constraint authority_approval_records_type_check
  check (approval_type in (
    'DRY_RUN_APPROVAL',
    'PROMOTION_APPROVAL',
    'ROLLBACK_APPROVAL',
    'SETTLEMENT_CERTIFICATION',
    'LEDGER_CERTIFICATION'
  ));
