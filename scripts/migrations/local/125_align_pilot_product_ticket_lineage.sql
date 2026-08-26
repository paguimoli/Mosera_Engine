begin;

create or replace function ticket_authority.manifest_allows_paytable(
  p_references jsonb,
  p_paytable_id text,
  p_version text
)
returns boolean
language sql
immutable
strict
as $$
  select exists (
    select 1
    from jsonb_array_elements(p_references) reference
    where case jsonb_typeof(reference)
      when 'object' then
        reference->>'paytableId' = p_paytable_id
        and reference->>'version' = p_version
      when 'string' then
        trim(both '"' from reference::text) = p_paytable_id || ':' || p_version
      else false
    end
  );
$$;

create or replace function ticket_authority.manifest_allows_wager_schema(
  p_schemas jsonb,
  p_wager_type text,
  p_version text
)
returns boolean
language sql
immutable
strict
as $$
  select exists (
    select 1
    from jsonb_array_elements(p_schemas) schema_reference
    where case jsonb_typeof(schema_reference)
      when 'object' then
        schema_reference->>'wagerType' = p_wager_type
        and schema_reference->>'version' = p_version
      when 'string' then
        case
          when trim(both '"' from schema_reference::text) like '%:%'
            then trim(both '"' from schema_reference::text) = p_wager_type || ':' || p_version
          else trim(both '"' from schema_reference::text) = p_wager_type
            and p_version = '1.0.0'
        end
      else false
    end
  );
$$;

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
    E'    and lifecycle_state = ''ProductionActive''',
    E'    and (lifecycle_state = ''ProductionActive''\n      or (lifecycle_state = ''GovernanceApproved''\n        and v_product_version.publication_state = ''PUBLISHED''\n        and v_product_version.approval_state in (''INTERNAL_APPROVED'', ''EXTERNAL_APPROVED'')))'
  );
  if v_updated = v_definition then
    raise exception 'Pilot product lifecycle compatibility could not be installed.';
  end if;
  v_definition := v_updated;

  v_updated := replace(
    v_definition,
    E'  if not (\n    v_manifest.paytable_references @>\n      jsonb_build_array(jsonb_build_object(\n        ''paytableId'', v_paytable.paytable_id,\n        ''version'', v_paytable.version\n      ))\n  ) then',
    E'  if not ticket_authority.manifest_allows_paytable(\n    v_manifest.paytable_references, v_paytable.paytable_id, v_paytable.version\n  ) then'
  );
  if v_updated = v_definition then
    raise exception 'Pilot product paytable lineage compatibility could not be installed.';
  end if;
  v_definition := v_updated;

  v_updated := replace(
    v_definition,
    E'    if not (\n      v_manifest.wager_schemas @>\n        jsonb_build_array(jsonb_build_object(\n          ''wagerType'', v_item->>''wagerType'',\n          ''version'', v_item->>''wagerVersion''\n        ))\n    ) then',
    E'    if not ticket_authority.manifest_allows_wager_schema(\n      v_manifest.wager_schemas, v_item->>''wagerType'', v_item->>''wagerVersion''\n    ) then'
  );
  if v_updated = v_definition then
    raise exception 'Pilot product wager lineage compatibility could not be installed.';
  end if;

  execute v_updated;
end;
$$;

create or replace function ticket_authority.validate_ticket_item_lineage()
returns trigger
language plpgsql
as $$
declare v_manifest game_engine.game_manifests%rowtype;
begin
  select manifest.* into v_manifest
  from ticket_authority.tickets ticket
  join game_engine.game_manifests manifest on manifest.id = ticket.manifest_id
  where ticket.ticket_id = new.ticket_id;
  if not found then
    raise exception 'Ticket item parent lineage was not found.';
  end if;
  if not ticket_authority.manifest_allows_wager_schema(
    v_manifest.wager_schemas, new.wager_type, new.wager_version
  ) then
    raise exception 'Ticket item wager schema/version is not authorized by the parent manifest.';
  end if;
  return new;
end;
$$;

comment on function ticket_authority.manifest_allows_paytable(jsonb,text,text) is
  'Validates exact immutable paytable lineage in object-form contracts and established compact id:version Game Manifest v1 references.';
comment on function ticket_authority.manifest_allows_wager_schema(jsonb,text,text) is
  'Validates exact object-form wager contracts and established compact Game Manifest v1 wager references; unversioned compact references are v1.0.0 only.';

commit;
