begin;

alter table game_engine.game_definition_versions
  add constraint ux_game_definition_version_ticket_lineage
  unique (id, game_definition_id, version_number, definition_hash);

alter table ticket_authority.tickets
  drop constraint fk_ticket_product_version_lineage;

alter table ticket_authority.tickets
  add constraint fk_ticket_product_version_lineage
  foreign key (product_version_id, product_id, product_version, game_configuration_hash)
  references game_engine.game_definition_versions(
    id, game_definition_id, version_number, definition_hash
  )
  on delete restrict
  not valid;

do $$
declare
  v_identity regprocedure :=
    'ticket_authority.persist_authorized_ticket(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,jsonb,text,text,text,text,text)'::regprocedure;
  v_definition text;
  v_updated text;
begin
  select pg_get_functiondef(v_identity) into v_definition;

  v_updated := replace(
    v_definition,
    E'  if not found then\n    raise exception ''active immutable paytable is unavailable'';\n  end if;\n  if not ticket_authority.manifest_allows_paytable(',
    E'  if not found then\n    raise exception ''active immutable paytable is unavailable'';\n  end if;\n  if v_product_version.paytable_definition_id is distinct from v_paytable.id\n     or v_product_version.paytable_hash is distinct from v_paytable.content_hash\n     or v_product_version.paytable_version not in (\n       v_paytable.version,\n       v_paytable.paytable_id || '':'' || v_paytable.version\n     ) then\n    raise exception ''paytable does not match the exact immutable Product version lineage'';\n  end if;\n  if not ticket_authority.manifest_allows_paytable('
  );
  if v_updated = v_definition then
    raise exception 'Exact ticket Product/paytable lineage validation could not be installed.';
  end if;

  execute v_updated;
end;
$$;

alter table ticket_authority.tickets
  validate constraint fk_ticket_product_version_lineage;

comment on constraint fk_ticket_product_version_lineage on ticket_authority.tickets is
  'Binds ticket Product identity/version/hash. Exact paytable identity/version/hash is enforced independently by fk_ticket_paytable_lineage and by canonical persistence validation against the Product version.';

commit;
