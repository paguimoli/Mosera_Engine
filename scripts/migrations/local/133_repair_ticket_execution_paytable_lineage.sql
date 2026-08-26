begin;

alter table game_engine.draw_execution_manifests
  add constraint ux_draw_execution_manifest_ticket_lineage
  unique (execution_manifest_id, draw_id, game_definition_version_id, canonical_manifest_hash);

alter table ticket_authority.tickets
  drop constraint fk_ticket_execution_manifest_lineage;

alter table ticket_authority.tickets
  add constraint fk_ticket_execution_manifest_lineage
  foreign key (execution_manifest_id, draw_id, product_version_id, execution_manifest_hash)
  references game_engine.draw_execution_manifests(
    execution_manifest_id, draw_id, game_definition_version_id, canonical_manifest_hash
  )
  on delete restrict
  not valid;

do $$
declare
  v_identity regprocedure := 'ticket_authority.bind_and_validate_ticket_lineage()'::regprocedure;
  v_definition text;
  v_updated text;
begin
  select pg_get_functiondef(v_identity) into v_definition;

  v_updated := replace(
    v_definition,
    E'  if not found then\n    raise exception ''Canonical ticket requires one exact Draw Execution Manifest.'';\n  end if;\n  new.execution_manifest_id := v_manifest.execution_manifest_id;',
    E'  if not found then\n    raise exception ''Canonical ticket requires one exact Draw Execution Manifest.'';\n  end if;\n  if v_manifest.paytable_version not in (\n    new.paytable_version,\n    new.paytable_id || '':'' || new.paytable_version\n  ) then\n    raise exception ''Canonical ticket Paytable does not match its Draw Execution Manifest.'';\n  end if;\n  new.execution_manifest_id := v_manifest.execution_manifest_id;'
  );
  if v_updated = v_definition then
    raise exception 'Exact ticket Execution Manifest/paytable validation could not be installed.';
  end if;

  execute v_updated;
end;
$$;

alter table ticket_authority.tickets
  validate constraint fk_ticket_execution_manifest_lineage;

comment on constraint fk_ticket_execution_manifest_lineage on ticket_authority.tickets is
  'Binds the exact Draw Execution Manifest, Draw, Product version, and manifest hash. Compact Paytable reference compatibility is validated canonically by the lineage trigger.';

commit;
