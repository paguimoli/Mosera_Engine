begin;

insert into game_engine.durable_scheduler_product_sequences(
  product_code,
  next_public_draw_number)
select
  product_code,
  max(public_draw_number) + 1
from game_engine.durable_scheduler_draws
group by product_code
on conflict (product_code) do update
set next_public_draw_number = greatest(
  game_engine.durable_scheduler_product_sequences.next_public_draw_number,
  excluded.next_public_draw_number);

do $$
begin
  if exists (
    select 1
    from game_engine.durable_scheduler_product_sequences sequence
    join lateral (
      select max(draw.public_draw_number) maximum_public_draw_number
      from game_engine.durable_scheduler_draws draw
      where draw.product_code = sequence.product_code
    ) observed on true
    where sequence.next_public_draw_number <= observed.maximum_public_draw_number
  ) then
    raise exception 'Durable scheduler public draw sequence repair did not advance beyond authoritative history.';
  end if;
end;
$$;

comment on table game_engine.durable_scheduler_product_sequences is
  'Allocates monotonic product-scoped public draw numbers and bootstraps strictly after durable authoritative draw history.';

commit;
