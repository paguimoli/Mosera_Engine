begin;

do $$
declare
  v_identity regprocedure :=
    'ticket_authority.accept_ticket(uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,text,text,text,jsonb,text,text,text,text,text)'::regprocedure;
  v_definition text;
  v_updated text;
begin
  select pg_get_functiondef(v_identity) into v_definition;

  v_updated := replace(
    v_definition,
    $needle$  v_item jsonb;$needle$,
    $replacement$  v_item jsonb;
  v_product_configuration jsonb;
  v_item_stake bigint;
  v_item_selection text;
  v_market jsonb;
  v_numbers jsonb;
  v_spot_count integer;
  v_valid_spot_count integer;
  v_distinct_spot_count integer;$replacement$
  );
  if v_updated = v_definition then
    raise exception 'Pilot product limit enforcement could not add acceptance state.';
  end if;
  v_definition := v_updated;

  v_updated := replace(
    v_definition,
    $needle$  if not found then
    raise exception 'active canonical game product is unavailable';
  end if;

  v_decided_at := clock_timestamp();$needle$,
    $replacement$  if not found then
    raise exception 'active canonical game product is unavailable';
  end if;

  select version.product_configuration into v_product_configuration
  from game_engine.game_definition_versions version
  where version.id = v_product.active_version_id
    and version.game_definition_id = v_product.id
    and version.publication_state = 'PUBLISHED'
    and version.activation_state = 'ACTIVE'
    and version.assignment_state = 'ASSIGNED'
    and (version.effective_from is null or version.effective_from <= clock_timestamp())
    and (version.effective_to is null or version.effective_to > clock_timestamp());
  if not found then
    raise exception 'effective immutable product configuration is required';
  end if;

  v_decided_at := clock_timestamp();$replacement$
  );
  if v_updated = v_definition then
    raise exception 'Pilot product limit enforcement could not bind the active configuration.';
  end if;
  v_definition := v_updated;

  v_updated := replace(
    v_definition,
    $needle$  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'ticket requires at least one wager item';
  end if;
  for v_item in select value from jsonb_array_elements(p_items)$needle$,
    $replacement$  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'ticket requires at least one wager item';
  end if;

  if v_product.code = 'FAST_KENO_V1' then
    if jsonb_array_length(p_items) >
       (v_product_configuration #>> '{wagering,maximumWagersPerTicket}')::integer then
      raise exception 'Fast Keno ticket exceeds maximum wagers per ticket';
    end if;
    for v_item in select value from jsonb_array_elements(p_items)
    loop
      v_item_stake := coalesce((v_item->>'stakeMinor')::bigint, 0);
      if v_item_stake <
         (v_product_configuration #>> '{wagering,minimumStakeMinor}')::bigint then
        raise exception 'Fast Keno wager is below the product minimum stake';
      end if;
      v_item_selection := upper(btrim(coalesce(v_item #>> '{selections,selection}', '')));
      select market.value into v_market
      from jsonb_array_elements(v_product_configuration #> '{wagering,markets}') market(value)
      where upper(market.value->>'code') = v_item_selection
      limit 1;
      if not found then
        raise exception 'Fast Keno wager references an unsupported product market';
      end if;
      if v_item_stake > (v_market->>'maximumStakeMinor')::bigint then
        raise exception 'Fast Keno wager exceeds the product market maximum stake';
      end if;
    end loop;
  elsif v_product.code = 'HOT_SPOT_V1' then
    if jsonb_array_length(p_items) >
       (v_product_configuration #>> '{wagering,maximumPlaysPerTicket}')::integer then
      raise exception 'Hot Spot ticket exceeds maximum plays per ticket';
    end if;
    for v_item in select value from jsonb_array_elements(p_items)
    loop
      v_item_stake := coalesce((v_item->>'stakeMinor')::bigint, 0);
      if v_item_stake < (v_product_configuration #>> '{wagering,baseStakeMinor,min}')::bigint
         or v_item_stake > (v_product_configuration #>> '{wagering,baseStakeMinor,max}')::bigint then
        raise exception 'Hot Spot play stake is outside the product range';
      end if;
      v_numbers := v_item #> '{selections,numbers}';
      if v_numbers is null or jsonb_typeof(v_numbers) <> 'array' then
        raise exception 'Hot Spot play requires a number selection';
      end if;
      v_spot_count := jsonb_array_length(v_numbers);
      select
        count(*) filter (where jsonb_typeof(number.value) = 'number'
          and (number.value::text)::integer between 1 and 80)::integer,
        count(distinct number.value)::integer
      into v_valid_spot_count, v_distinct_spot_count
      from jsonb_array_elements(v_numbers) number(value);
      if v_valid_spot_count <> v_spot_count
         or v_distinct_spot_count <> v_spot_count then
        raise exception 'Hot Spot play numbers must be unique integers from 1 through 80';
      end if;
      if not ((v_product_configuration #> '{wagering,spotCounts}') @> jsonb_build_array(v_spot_count)) then
        raise exception 'Hot Spot play uses an unsupported spot count';
      end if;
    end loop;
  end if;

  for v_item in select value from jsonb_array_elements(p_items)$replacement$
  );
  if v_updated = v_definition then
    raise exception 'Pilot product limit enforcement could not install fail-closed validation.';
  end if;

  execute v_updated;
end;
$$;

comment on function ticket_authority.accept_ticket(
  uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,text,text,text,jsonb,text,text,text,text,text
) is
  'Sole ticket acceptance authority: validates immutable product limits, derives effective availability, fences draw close, resolves funding, reserves, and persists atomically.';

commit;
