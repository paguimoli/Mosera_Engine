create schema if not exists platform;

create or replace function platform.validate_platform_game_availability()
returns trigger
language plpgsql
as $$
declare
  brand_tenant_id uuid;
  market_brand_id uuid;
  website_tenant_id uuid;
  website_brand_id uuid;
  website_market_id uuid;
begin
  if btrim(new.game_id) = '' then
    raise exception 'game_id is required';
  end if;

  if btrim(new.game_code) = '' then
    raise exception 'game_code is required';
  end if;

  if btrim(new.version) = '' then
    raise exception 'game availability version is required';
  end if;

  if new.content_hash !~ '^sha256:' then
    raise exception 'game availability content_hash must use sha256 prefix';
  end if;

  if new.effective_to is not null and new.effective_to <= new.effective_from then
    raise exception 'game availability effective_to must be after effective_from';
  end if;

  if new.min_wager_override is not null and new.min_wager_override < 0 then
    raise exception 'min_wager_override must be non-negative';
  end if;

  if new.max_wager_override is not null and new.max_wager_override < 0 then
    raise exception 'max_wager_override must be non-negative';
  end if;

  if new.min_wager_override is not null
    and new.max_wager_override is not null
    and new.max_wager_override < new.min_wager_override then
    raise exception 'max_wager_override must be greater than or equal to min_wager_override';
  end if;

  select tenant_id
  into brand_tenant_id
  from platform.brands
  where id = new.brand_id;

  if brand_tenant_id is null then
    raise exception 'game availability brand_id must reference an existing brand';
  end if;

  if brand_tenant_id <> new.tenant_id then
    raise exception 'game availability tenant_id must match brand tenant_id';
  end if;

  if new.market_id is not null then
    select brand_id
    into market_brand_id
    from platform.markets
    where id = new.market_id;

    if market_brand_id is null then
      raise exception 'game availability market_id must reference an existing market when provided';
    end if;

    if market_brand_id <> new.brand_id then
      raise exception 'game availability market_id must belong to brand_id';
    end if;
  end if;

  if new.website_id is not null then
    select tenant_id, brand_id, market_id
    into website_tenant_id, website_brand_id, website_market_id
    from platform.websites
    where id = new.website_id;

    if website_tenant_id is null then
      raise exception 'game availability website_id must reference an existing website when provided';
    end if;

    if website_tenant_id <> new.tenant_id or website_brand_id <> new.brand_id then
      raise exception 'game availability website_id must belong to tenant_id and brand_id';
    end if;

    if new.market_id is not null and website_market_id is not null and website_market_id <> new.market_id then
      raise exception 'game availability website market must match market_id when both are scoped';
    end if;
  end if;

  return new;
end;
$$;

create table if not exists platform.game_availability (
  id uuid primary key,
  tenant_id uuid not null references platform.tenants(id),
  brand_id uuid not null references platform.brands(id),
  market_id uuid references platform.markets(id),
  website_id uuid references platform.websites(id),
  agent_id text,
  game_id text not null,
  game_code text not null,
  game_manifest_reference text,
  jurisdiction text,
  status text not null,
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  min_wager_override numeric(18, 2),
  max_wager_override numeric(18, 2),
  language_override text,
  currency_override text,
  timezone_override text,
  version text not null,
  content_hash text not null,
  audit_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_platform_game_availability_status check (status in ('Draft', 'Active', 'Suspended', 'Retired')),
  constraint ck_platform_game_availability_game_code_trimmed check (game_code = lower(btrim(game_code))),
  constraint ck_platform_game_availability_agent_trimmed check (agent_id is null or agent_id = lower(btrim(agent_id))),
  constraint ux_platform_game_availability_content_hash unique (content_hash)
);

create unique index if not exists ux_platform_game_availability_scope_game_version
  on platform.game_availability (
    tenant_id,
    brand_id,
    coalesce(market_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(website_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(agent_id, ''),
    game_code,
    version
  );

create index if not exists idx_platform_game_availability_tenant_brand on platform.game_availability (tenant_id, brand_id);
create index if not exists idx_platform_game_availability_market on platform.game_availability (market_id);
create index if not exists idx_platform_game_availability_website on platform.game_availability (website_id);
create index if not exists idx_platform_game_availability_agent on platform.game_availability (agent_id);
create index if not exists idx_platform_game_availability_game_status on platform.game_availability (game_code, status);
create index if not exists idx_platform_game_availability_effective_window on platform.game_availability (effective_from, effective_to);
create index if not exists idx_platform_game_availability_hash on platform.game_availability (content_hash);

drop trigger if exists trg_validate_platform_game_availability on platform.game_availability;
create trigger trg_validate_platform_game_availability
before insert on platform.game_availability
for each row execute function platform.validate_platform_game_availability();

drop trigger if exists trg_prevent_platform_game_availability_update on platform.game_availability;
create trigger trg_prevent_platform_game_availability_update
before update on platform.game_availability
for each row execute function platform.prevent_platform_foundation_update();

drop trigger if exists trg_prevent_platform_game_availability_delete on platform.game_availability;
create trigger trg_prevent_platform_game_availability_delete
before delete on platform.game_availability
for each row execute function platform.prevent_platform_foundation_delete();

create or replace function platform.resolve_game_availability(
  p_tenant_id uuid,
  p_brand_id uuid,
  p_market_id uuid default null,
  p_website_id uuid default null,
  p_agent_id text default null,
  p_as_of timestamptz default now()
)
returns table (
  availability_id uuid,
  tenant_id uuid,
  brand_id uuid,
  market_id uuid,
  website_id uuid,
  agent_id text,
  game_id text,
  game_code text,
  game_manifest_reference text,
  status text,
  is_available boolean,
  specificity_rank integer,
  min_wager_override numeric(18, 2),
  max_wager_override numeric(18, 2),
  language_override text,
  currency_override text,
  timezone_override text,
  content_hash text
)
language sql
stable
as $$
  select distinct on (candidate.game_code)
    candidate.id as availability_id,
    candidate.tenant_id,
    candidate.brand_id,
    candidate.market_id,
    candidate.website_id,
    candidate.agent_id,
    candidate.game_id,
    candidate.game_code,
    candidate.game_manifest_reference,
    candidate.status,
    candidate.status = 'Active' as is_available,
    case
      when candidate.agent_id is not null then 5
      when candidate.website_id is not null then 4
      when candidate.market_id is not null then 3
      when candidate.brand_id is not null then 2
      else 1
    end as specificity_rank,
    candidate.min_wager_override,
    candidate.max_wager_override,
    candidate.language_override,
    candidate.currency_override,
    candidate.timezone_override,
    candidate.content_hash
  from platform.game_availability candidate
  where candidate.tenant_id = p_tenant_id
    and candidate.brand_id = p_brand_id
    and candidate.status in ('Active', 'Suspended', 'Retired')
    and candidate.effective_from <= p_as_of
    and (candidate.effective_to is null or candidate.effective_to > p_as_of)
    and (candidate.market_id is null or candidate.market_id = p_market_id)
    and (candidate.website_id is null or candidate.website_id = p_website_id)
    and (candidate.agent_id is null or candidate.agent_id = lower(btrim(p_agent_id)))
  order by
    candidate.game_code,
    case
      when candidate.agent_id is not null then 5
      when candidate.website_id is not null then 4
      when candidate.market_id is not null then 3
      when candidate.brand_id is not null then 2
      else 1
    end desc,
    candidate.effective_from desc,
    candidate.created_at desc;
$$;
