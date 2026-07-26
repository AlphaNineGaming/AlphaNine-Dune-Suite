package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var runtimeVersion = "development"

type SafetyConfig struct {
	MaxCreatesPerCycle int   `json:"maxCreatesPerCycle"`
	MaxMarketValue     int64 `json:"maxMarketValuePerCycle"`
}

type ItemPolicy struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Category       string `json:"category"`
	Tier           string `json:"tier"`
	Enabled        bool   `json:"enabled"`
	UnitPrice      int64  `json:"unitPrice"`
	StackSize      int    `json:"stackSize"`
	TargetListings int    `json:"targetListings"`
	CategoryMask   int    `json:"categoryMask"`
	CategoryDepth  int    `json:"categoryDepth"`
}

type Config struct {
	SchemaVersion   int          `json:"schemaVersion"`
	RuntimeVersion  string       `json:"runtimeVersion"`
	Enabled         bool         `json:"enabled"`
	Paused          bool         `json:"paused"`
	Activated       bool         `json:"activated"`
	Battlegroup     string       `json:"battlegroup"`
	Namespace       string       `json:"namespace"`
	DBPod           string       `json:"dbPod"`
	DBService       string       `json:"dbService"`
	ExchangeName    string       `json:"exchangeName"`
	EconomyStyle    string       `json:"economyStyle"`
	ListingCategory string       `json:"listingCategory"`
	IntervalMinutes int          `json:"intervalMinutes"`
	ExpiryDays      int          `json:"expiryDays"`
	Safety          SafetyConfig `json:"safety"`
	Items           []ItemPolicy `json:"items"`
}

type State struct {
	InstalledVersion string      `json:"installedVersion"`
	Status           string      `json:"status"`
	Message          string      `json:"message"`
	LastCycle        interface{} `json:"lastCycle,omitempty"`
	LastRunAt        string      `json:"lastRunAt,omitempty"`
	NextRunAt        string      `json:"nextRunAt,omitempty"`
	UpdatedAt        string      `json:"updatedAt"`
}

type commandResult struct {
	OK      bool            `json:"ok"`
	Status  string          `json:"status"`
	Message string          `json:"message,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   string          `json:"error,omitempty"`
}

type paths struct {
	config string
	state  string
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		writeJSON(commandResult{OK: false, Status: "Error", Error: redact(err.Error())})
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: alphanine-market-bot <daemon|preview|restock|clean|status|pause|resume|migrate|self-test>")
	}
	if args[0] == "--version" || args[0] == "version" {
		writeJSON(map[string]interface{}{"ok": true, "name": "AlphaNine Market Bot", "version": runtimeVersion, "goos": "linux", "goarch": "amd64"})
		return nil
	}
	p := runtimePaths()
	switch args[0] {
	case "status":
		state, _ := readState(p.state)
		cfg, err := readConfig(p.config)
		if err != nil {
			return err
		}
		if state.InstalledVersion == "" {
			state = stateForConfig(cfg, "Paused", "Market Bot is installed and has not run yet.", nil)
		}
		writeJSON(map[string]interface{}{"ok": true, "installed": true, "version": runtimeVersion, "config": publicConfig(cfg), "state": state})
		return nil
	case "self-test":
		cfg, err := readConfig(p.config)
		if err != nil {
			return err
		}
		if _, err := exec.LookPath("kubectl"); err != nil {
			return errors.New("kubectl is not available in the VM")
		}
		if _, err := exec.LookPath("sudo"); err != nil {
			return errors.New("sudo is not available in the VM")
		}
		if err := validateConfig(cfg); err != nil {
			return err
		}
		writeJSON(commandResult{OK: true, Status: "Ready", Message: fmt.Sprintf("Market Bot %s self-test passed for %s.", runtimeVersion, cfg.Battlegroup)})
		return nil
	case "migrate":
		cfg, err := readConfig(p.config)
		if err != nil {
			return err
		}
		raw, err := executeSQL(cfg, migrationSQL())
		if err != nil {
			return err
		}
		writeJSON(commandResult{OK: true, Status: "Paused", Message: "Ownership metadata is ready; no listings were changed.", Result: raw})
		return nil
	case "pause", "resume":
		cfg, err := readConfig(p.config)
		if err != nil {
			return err
		}
		cfg.Paused = args[0] == "pause"
		if err := writeAtomicJSON(p.config, cfg, 0640); err != nil {
			return err
		}
		status := "Running"
		message := "Market Bot resumed."
		if cfg.Paused {
			status = "Paused"
			message = "Market Bot paused; active listings were left unchanged."
		}
		state := stateForConfig(cfg, status, message, nil)
		_ = writeAtomicJSON(p.state, state, 0640)
		writeJSON(commandResult{OK: true, Status: status, Message: message})
		return nil
	case "clean":
		cfg, err := readConfig(p.config)
		if err != nil {
			return err
		}
		cfg.Paused = true
		if err := writeAtomicJSON(p.config, cfg, 0640); err != nil {
			return err
		}
		raw, err := executeSQL(cfg, cleanupSQL(cfg))
		if err != nil {
			return err
		}
		message := resultMessage(raw)
		state := stateForConfig(cfg, "Paused", message, raw)
		_ = writeAtomicJSON(p.state, state, 0640)
		writeJSON(commandResult{OK: true, Status: "Paused", Message: message, Result: raw})
		return nil
	case "preview", "restock":
		cfg, err := readConfig(p.config)
		if err != nil {
			return err
		}
		if args[0] == "restock" && (!cfg.Enabled || !cfg.Activated || cfg.Paused) {
			return errors.New("Market Bot is not active; enable and resume it before restocking")
		}
		cycleID := flagValue(args[1:], "--cycle-id")
		if cycleID == "" {
			cycleID = cycleKey(cfg.IntervalMinutes, time.Now().UTC())
			if args[0] == "preview" {
				cycleID = "preview-" + strconv.FormatInt(time.Now().UnixNano(), 10)
			}
		}
		result, status, err := reconcile(cfg, cycleID, args[0] == "restock")
		if err != nil {
			state := stateForConfig(cfg, status, redact(err.Error()), nil)
			_ = writeAtomicJSON(p.state, state, 0640)
			return err
		}
		if args[0] == "restock" {
			state := stateForConfig(cfg, status, resultMessage(result), result)
			_ = writeAtomicJSON(p.state, state, 0640)
		}
		writeJSON(commandResult{OK: true, Status: status, Message: resultMessage(result), Result: result})
		return nil
	case "daemon":
		return daemon(p)
	default:
		return fmt.Errorf("unknown Market Bot action %q", args[0])
	}
}

func runtimePaths() paths {
	root := strings.TrimSpace(os.Getenv("ALPHANINE_MARKET_BOT_DIR"))
	if root == "" {
		root = "/home/dune/.dune/alphanine-market-bot"
	}
	return paths{config: filepath.Join(root, "config.json"), state: filepath.Join(root, "state.json")}
}

func readConfig(file string) (Config, error) {
	var cfg Config
	body, err := os.ReadFile(file)
	if err != nil {
		return cfg, fmt.Errorf("read Market Bot config: %w", err)
	}
	if err := json.Unmarshal(body, &cfg); err != nil {
		return cfg, fmt.Errorf("parse Market Bot config: %w", err)
	}
	return cfg, validateConfig(cfg)
}

func validateConfig(cfg Config) error {
	if cfg.SchemaVersion != 1 {
		return fmt.Errorf("unsupported config schema %d", cfg.SchemaVersion)
	}
	for label, value := range map[string]string{"battlegroup": cfg.Battlegroup, "namespace": cfg.Namespace, "database pod": cfg.DBPod, "database service": cfg.DBService} {
		if value == "" || !safeKubeName(value) {
			return fmt.Errorf("invalid %s", label)
		}
	}
	if cfg.IntervalMinutes < 1 || cfg.IntervalMinutes > 1440 {
		return errors.New("intervalMinutes must be from 1 to 1440")
	}
	if cfg.ExpiryDays < 1 || cfg.ExpiryDays > 14 {
		return errors.New("expiryDays must be from 1 to 14")
	}
	if cfg.Safety.MaxCreatesPerCycle < 1 || cfg.Safety.MaxCreatesPerCycle > 250 {
		return errors.New("maxCreatesPerCycle must be from 1 to 250")
	}
	if cfg.Safety.MaxMarketValue < 1 {
		return errors.New("maxMarketValuePerCycle must be positive")
	}
	seen := map[string]bool{}
	for _, item := range cfg.Items {
		if item.ID == "" || len(item.ID) > 240 || strings.ContainsAny(item.ID, "\r\n\t") {
			return errors.New("item policy contains an invalid template ID")
		}
		key := strings.ToLower(item.ID)
		if seen[key] {
			return fmt.Errorf("duplicate item policy %s", item.ID)
		}
		seen[key] = true
		if item.UnitPrice < 1 || item.UnitPrice > 999999999 || item.StackSize < 1 || item.StackSize > 50000 || item.TargetListings < 0 || item.TargetListings > 100 {
			return fmt.Errorf("item policy is outside safety bounds: %s", item.ID)
		}
	}
	return nil
}

func safeKubeName(value string) bool {
	if len(value) < 1 || len(value) > 253 {
		return false
	}
	for _, r := range value {
		if !((r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '.') {
			return false
		}
	}
	return true
}

func daemon(p paths) error {
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	timer := time.NewTicker(15 * time.Second)
	defer timer.Stop()
	var lastCycle string
	for {
		cfg, err := readConfig(p.config)
		if err != nil {
			_ = writeAtomicJSON(p.state, State{InstalledVersion: runtimeVersion, Status: "Error", Message: redact(err.Error()), UpdatedAt: time.Now().UTC().Format(time.RFC3339)}, 0640)
		} else if !cfg.Enabled || !cfg.Activated || cfg.Paused {
			_ = writeAtomicJSON(p.state, stateForConfig(cfg, "Paused", "Market Bot is paused; active listings are unchanged.", nil), 0640)
		} else {
			key := cycleKey(cfg.IntervalMinutes, time.Now().UTC())
			if key != lastCycle {
				result, status, cycleErr := reconcile(cfg, key, true)
				if cycleErr != nil {
					_ = writeAtomicJSON(p.state, stateForConfig(cfg, status, redact(cycleErr.Error()), nil), 0640)
				} else {
					lastCycle = key
					_ = writeAtomicJSON(p.state, stateForConfig(cfg, status, resultMessage(result), result), 0640)
				}
			}
		}
		select {
		case <-signals:
			return nil
		case <-timer.C:
		}
	}
}

func cycleKey(minutes int, now time.Time) string {
	if minutes < 1 {
		minutes = 30
	}
	bucket := now.Unix() / int64(minutes*60)
	return fmt.Sprintf("scheduled-%d-%d", minutes, bucket)
}

func reconcile(cfg Config, cycleID string, execute bool) (json.RawMessage, string, error) {
	if strings.ContainsAny(cycleID, "\r\n\t") || len(cycleID) > 160 {
		return nil, "Error", errors.New("invalid cycle ID")
	}
	sql := reconciliationSQL(cfg, cycleID, execute)
	raw, err := executeSQL(cfg, sql)
	if err != nil {
		if isWaitingError(err.Error()) {
			return nil, "Waiting for Exchange", err
		}
		return nil, "Error", err
	}
	var result map[string]interface{}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, "Error", fmt.Errorf("planner returned invalid JSON: %w", err)
	}
	status, _ := result["status"].(string)
	if status == "waiting" {
		return raw, "Waiting for Exchange", nil
	}
	if status == "lock-busy" {
		return raw, "Running", nil
	}
	return raw, "Running", nil
}

func executeSQL(cfg Config, sql string) (json.RawMessage, error) {
	passwordContext, cancelPassword := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelPassword()
	passwordCmd := exec.CommandContext(passwordContext, "sudo", "-n", "timeout", "-k", "5", "20", "kubectl", "exec", "-n", cfg.Namespace, cfg.DBPod, "--", "printenv", "POSTGRES_PASSWORD")
	password, err := passwordCmd.Output()
	if err != nil {
		if errors.Is(passwordContext.Err(), context.DeadlineExceeded) {
			return nil, errors.New("Waiting for Exchange: database credential lookup timed out while the DB pod was starting")
		}
		return nil, fmt.Errorf("Waiting for Exchange: could not read the database credential from the DB pod")
	}
	pw := strings.TrimSpace(string(password))
	if pw == "" {
		return nil, errors.New("Waiting for Exchange: database credential is unavailable")
	}
	args := []string{"-n", "timeout", "-k", "5", "120", "kubectl", "exec", "-i", "-n", cfg.Namespace, cfg.DBPod, "--", "env", "PGPASSWORD=" + pw, "psql", "-v", "ON_ERROR_STOP=1", "-h", cfg.DBService, "-p", "15432", "-U", "postgres", "-d", "dune", "-At", "-f", "-"}
	plannerContext, cancelPlanner := context.WithTimeout(context.Background(), 130*time.Second)
	defer cancelPlanner()
	cmd := exec.CommandContext(plannerContext, "sudo", args...)
	cmd.Stdin = strings.NewReader(sql)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if errors.Is(plannerContext.Err(), context.DeadlineExceeded) {
			return nil, errors.New("Waiting for Exchange: database planner timed out while the Exchange database was starting")
		}
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 143 {
			return nil, errors.New("Waiting for Exchange: database planner timed out while the Exchange database was starting")
		}
		return nil, fmt.Errorf("database planner failed: %s", redact(message))
	}
	lines := strings.Split(strings.TrimSpace(stdout.String()), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if json.Valid([]byte(line)) {
			return json.RawMessage(line), nil
		}
	}
	return nil, fmt.Errorf("database planner returned no JSON result: %s", redact(stdout.String()))
}

func migrationSQL() string {
	return `
begin;
create table if not exists public.alphanine_market_bot_cycles (
  cycle_id text primary key,
  mode text not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  result jsonb not null default '{}'::jsonb
);
create table if not exists public.alphanine_market_bot_listings (
  order_id bigint primary key,
  item_id bigint not null unique,
  template_id text not null,
  cycle_id text not null,
  unit_price bigint not null,
  stack_size integer not null,
  created_at timestamptz not null default now(),
  expiration_time bigint,
  retired_at timestamptz
);
create index if not exists alphanine_market_bot_listings_template_active
  on public.alphanine_market_bot_listings (template_id) where retired_at is null;
create table if not exists public.alphanine_market_bot_audit (
  id bigserial primary key,
  at timestamptz not null default now(),
  cycle_id text,
  event text not null,
  details jsonb not null default '{}'::jsonb
);
grant usage on schema public to dune;
grant select on table
  public.alphanine_market_bot_cycles,
  public.alphanine_market_bot_listings,
  public.alphanine_market_bot_audit
to dune;
grant select on sequence public.alphanine_market_bot_audit_id_seq to dune;
with selected_partition as (
  select partition_id from dune.world_partition order by partition_id limit 1
)
insert into dune.actors (class, serial, gas_attributes, properties, dimension_index, partition_id, owner_account_id)
select 'Duke', 0, '{}', '{}', 0, partition_id, null
from selected_partition
where not exists (
  select 1 from dune.actors where class='Duke' and owner_account_id is null
);
insert into dune.dune_exchange_users (owner_id)
select id from dune.actors
where class='Duke' and owner_account_id is null
on conflict do nothing;
with selected_duke as (
  select id from dune.actors where class='Duke' and owner_account_id is null order by id limit 1
),
legacy_bot as (
  select id from dune.actors
  where class='AlphaNineMarket' and properties->>'AlphaNineOwner'='market-bot-v1'
)
update dune.dune_exchange_orders o
set owner_id=(select id from selected_duke)
from public.alphanine_market_bot_listings m
where o.id=m.order_id and m.retired_at is null and o.owner_id in(select id from legacy_bot)
  and exists(select 1 from selected_duke);
commit;
select json_build_object('ok', true, 'status', 'ready', 'schemaVersion', 1)::text;`
}

func cleanupSQL(cfg Config) string {
	return fmt.Sprintf(`
begin;
with
lock_state as (
  select pg_try_advisory_xact_lock(hashtextextended(%s, 0)) acquired
),
bot_actor as (
  select id from dune.actors
  where class='Duke' and owner_account_id is null
  order by id limit 1
),
targets as materialized (
  select m.order_id,m.item_id
  from public.alphanine_market_bot_listings m
  join dune.dune_exchange_orders o on o.id=m.order_id
  join dune.dune_exchange_sell_orders s on s.order_id=o.id
  join dune.items i on i.id=m.item_id and i.id=o.item_id
  join bot_actor b on b.id=o.owner_id
  where m.retired_at is null and o.is_npc_order=true
    and (select acquired from lock_state)
  for update of o,i
),
deleted_sell as (
  delete from dune.dune_exchange_sell_orders
  where order_id in(select order_id from targets)
  returning order_id
),
deleted_orders as (
  delete from dune.dune_exchange_orders
  where id in(select order_id from deleted_sell)
  returning id
),
deleted_items as (
  delete from dune.items i
  using targets t,deleted_orders d
  where i.id=t.item_id and d.id=t.order_id
  returning i.id
),
retired as (
  update public.alphanine_market_bot_listings m
  set retired_at=now()
  where m.order_id in(select id from deleted_orders)
  returning m.order_id
),
audited as (
  insert into public.alphanine_market_bot_audit(cycle_id,event,details)
  select null,'cleaned',jsonb_build_object('removed',(select count(*) from retired))
  where (select acquired from lock_state)
  returning id
),
summary as (
  select json_build_object(
    'ok',(select acquired from lock_state),
    'status',case when (select acquired from lock_state) then 'cleaned' else 'lock-busy' end,
    'message',case
      when (select acquired from lock_state)
        then format('Cleaned %%s Market Bot-owned listings. Market Bot is paused.',(select count(*) from retired))
      else 'Another Market Bot operation holds the database lock.'
    end,
    'removed',(select count(*) from retired),
    'playerListingsChanged',0,
    'auditId',(select id from audited limit 1)
  ) result
)
select result::text from summary;
commit;`, sqlText("alphanine-market-bot:"+cfg.Namespace+":"+cfg.Battlegroup))
}

func reconciliationSQL(cfg Config, cycleID string, execute bool) string {
	mode := "preview"
	if execute {
		mode = "execute"
	}
	values := make([]string, 0, len(cfg.Items))
	for _, item := range cfg.Items {
		if !item.Enabled || item.TargetListings < 1 {
			continue
		}
		values = append(values, fmt.Sprintf("(%s,%s,%s,%s,%d,%d,%d,%d,%d)",
			sqlText(item.ID), sqlText(item.Name), sqlText(item.Category), sqlText(item.Tier), item.UnitPrice, item.StackSize,
			item.TargetListings, item.CategoryMask, item.CategoryDepth))
	}
	if len(values) == 0 {
		values = append(values, "('','','','',1,1,0,0,0)")
	}
	executeBool := "false"
	if execute {
		executeBool = "true"
	}
	exchangePredicate := "exchange_name <> 'Global'"
	if cfg.ExchangeName != "" {
		exchangePredicate = "exchange_name = " + sqlText(cfg.ExchangeName)
	}
	common := fmt.Sprintf(`
begin;
with
settings as (
  select %s::text cycle_id, %s::text mode, %s::boolean execute,
         %d::integer max_creates, %d::bigint max_value, %d::bigint expiry_seconds
),
lock_state as (
  select pg_try_advisory_xact_lock(hashtextextended(%s, 0)) acquired
),
policy(template_id, display_name, category, tier, unit_price, stack_size, target_count, category_mask, category_depth) as (
  values %s
),
selected_exchange as (
  select id exchange_id, inventory_id, exchange_name
  from dune.dune_exchanges
  where %s
  order by id
),
exchange_state as (
  select count(*) exchange_count, min(exchange_id) exchange_id, min(inventory_id) inventory_id, min(exchange_name) exchange_name
  from selected_exchange
),
selected_access_point as (
  select min(id) access_point_id,count(*) access_point_count
  from dune.dune_exchange_accesspoints
  where exchange_id=(select exchange_id from exchange_state)
),
player_clock as (
  select max(expiration_time) - 1209600 inferred_now
  from dune.dune_exchange_orders
  where is_npc_order=false and expiration_time between 1209601 and 999999999
),
database_clock as (
  select floor(extract(epoch from clock_timestamp()))::bigint database_now
),
game_clock as (
  select case
           when p.inferred_now between d.database_now-2592000 and d.database_now+2592000 then p.inferred_now
           else d.database_now
         end game_now,
         case
           when p.inferred_now between d.database_now-2592000 and d.database_now+2592000 then 'player-listing'
           else 'database-clock'
         end clock_source
  from player_clock p cross join database_clock d
),
bot_actor as (
  select id from dune.actors
  where class='Duke' and owner_account_id is null
  order by id limit 1
),
prior_cycle as (
  select result from public.alphanine_market_bot_cycles
  where cycle_id=(select cycle_id from settings) and completed_at is not null
),
valid_managed as (
  select m.order_id,m.item_id,m.template_id,o.expiration_time,i.stack_size
  from public.alphanine_market_bot_listings m
  join dune.dune_exchange_orders o on o.id=m.order_id
  join dune.dune_exchange_sell_orders s on s.order_id=o.id
  join dune.items i on i.id=m.item_id and i.id=o.item_id
  join bot_actor b on b.id=o.owner_id
  where m.retired_at is null and o.is_npc_order=true and o.template_id=m.template_id
    and o.category_mask>0 and o.category_depth>0
),
active_counts as (
  select template_id,count(*)::integer active
  from valid_managed v,game_clock g
  where v.stack_size>0 and v.expiration_time>g.game_now
  group by template_id
),
planned as (
  select p.*,coalesce(a.active,0) active_count,greatest(0,p.target_count-coalesce(a.active,0)) deficit
  from policy p left join active_counts a using(template_id)
  where p.target_count>0 and p.category_mask>0 and p.category_depth>0
),
expanded as (
  select p.*,n.ordinal
  from planned p cross join lateral generate_series(1,p.deficit) n(ordinal)
),
category_ranked as (
  select e.*,row_number() over(
    partition by lower(e.category)
    order by lower(e.display_name),e.template_id,e.ordinal
  ) category_sequence
  from expanded e
),
ranked as (
  select e.*,row_number() over(
           order by e.category_sequence,lower(e.category),lower(e.display_name),e.template_id,e.ordinal
         ) sequence,
         sum(e.unit_price*e.stack_size) over(
           order by e.category_sequence,lower(e.category),lower(e.display_name),e.template_id,e.ordinal
         ) cumulative_value
  from category_ranked e
),
approved as (
  select * from ranked r,settings s
  where r.sequence<=s.max_creates and r.cumulative_value<=s.max_value
),
summary as (
  select json_build_object(
    'ok',true,
    'status',case
      when not (select acquired from lock_state) then 'lock-busy'
      when (select exchange_count from exchange_state)<>1 then 'waiting'
      when (select inventory_id from exchange_state) is null then 'waiting'
      when (select access_point_count from selected_access_point)<1 then 'waiting'
      when (select game_now from game_clock)<=0 then 'waiting'
      when not exists(select 1 from bot_actor) then 'waiting'
      else 'planned' end,
    'message',case
      when not (select acquired from lock_state) then 'Another Market Bot cycle holds the database lock.'
      when (select exchange_count from exchange_state)<>1 then 'Waiting for exactly one usable Exchange.'
      when (select inventory_id from exchange_state) is null then 'Waiting for the Exchange inventory.'
      when (select access_point_count from selected_access_point)<1 then 'Waiting for an Exchange access point.'
      when (select game_now from game_clock)<=0 then 'Waiting for a verified Exchange clock.'
      when not exists(select 1 from bot_actor) then 'Waiting for the dedicated Market Bot actor.'
      else 'Market plan is ready.' end,
    'cycleId',(select cycle_id from settings),
    'mode',(select mode from settings),
    'exchange',(select exchange_name from exchange_state),
    'gameNow',(select game_now from game_clock),
    'clockSource',(select clock_source from game_clock),
    'items',coalesce((select json_agg(json_build_object(
      'id',p.template_id,'name',p.display_name,'category',p.category,'tier',p.tier,'unitPrice',p.unit_price,
      'stackSize',p.stack_size,'targetListings',p.target_count,'activeListings',p.active_count,
      'deficit',p.deficit,'createNow',(select count(*) from approved a where a.template_id=p.template_id),
      'plannedValue',p.unit_price*p.stack_size*(select count(*) from approved a where a.template_id=p.template_id)
    ) order by lower(p.category),lower(p.display_name),p.template_id) from planned p),'[]'::json),
    'totals',json_build_object(
      'configuredCatalogItems',(select count(*) from policy where target_count>0),
      'catalogItems',(select count(*) from planned),
      'skippedUnknownCategoryMasks',(select count(*) from policy where target_count>0 and (category_mask<=0 or category_depth<=0)),
      'activeListings',coalesce((select sum(active_count) from planned),0),
      'totalDeficit',coalesce((select sum(deficit) from planned),0),
      'createNow',(select count(*) from approved),
      'marketValue',coalesce((select sum(unit_price*stack_size) from approved),0),
      'maxCreates',(select max_creates from settings),
      'maxMarketValue',(select max_value from settings)
    ),
    'categories',coalesce((
      select json_agg(json_build_object(
        'category',c.category,'items',c.items,'activeListings',c.active_listings,
        'targetListings',c.target_listings,'deficit',c.deficit,'createNow',c.create_now,
        'plannedValue',c.planned_value
      ) order by lower(c.category))
      from (
        select p.category,count(*) items,sum(p.active_count) active_listings,
               sum(p.target_count) target_listings,sum(p.deficit) deficit,
               sum((select count(*) from approved a where a.template_id=p.template_id)) create_now,
               sum(p.unit_price*p.stack_size*(select count(*) from approved a where a.template_id=p.template_id)) planned_value
        from planned p group by p.category
      ) c
    ),'[]'::json),
    'warning','Only category-verified listings count as active. Existing valid listings are never repriced or reposted. Player listings are never changed.'
  ) result
)
select result::text from summary;
rollback;`, sqlText(cycleID), sqlText(mode), executeBool,
		cfg.Safety.MaxCreatesPerCycle, cfg.Safety.MaxMarketValue, int64(cfg.ExpiryDays)*86400,
		sqlText("alphanine-market-bot:"+cfg.Namespace+":"+cfg.Battlegroup), strings.Join(values, ",\n"), exchangePredicate)
	if !execute {
		return common
	}
	return fmt.Sprintf(`
begin;
with
settings as (
  select %s::text cycle_id, 'execute'::text mode,
         %d::integer max_creates, %d::bigint max_value, %d::bigint expiry_seconds
),
lock_state as (
  select pg_try_advisory_xact_lock(hashtextextended(%s, 0)) acquired
),
prior_cycle as (
  select result from public.alphanine_market_bot_cycles
  where cycle_id=(select cycle_id from settings) and completed_at is not null
),
policy(template_id, display_name, category, tier, unit_price, stack_size, target_count, category_mask, category_depth) as (
  values %s
),
selected_exchange as (
  select id exchange_id, inventory_id, exchange_name
  from dune.dune_exchanges
  where %s
  order by id
),
exchange_state as (
  select count(*) exchange_count, min(exchange_id) exchange_id, min(inventory_id) inventory_id, min(exchange_name) exchange_name
  from selected_exchange
),
selected_access_point as (
  select min(id) access_point_id,count(*) access_point_count
  from dune.dune_exchange_accesspoints
  where exchange_id=(select exchange_id from exchange_state)
),
player_clock as (
  select max(expiration_time)-1209600 inferred_now
  from dune.dune_exchange_orders
  where is_npc_order=false and expiration_time between 1209601 and 999999999
),
database_clock as (
  select floor(extract(epoch from clock_timestamp()))::bigint database_now
),
game_clock as (
  select case
           when p.inferred_now between d.database_now-2592000 and d.database_now+2592000 then p.inferred_now
           else d.database_now
         end game_now,
         case
           when p.inferred_now between d.database_now-2592000 and d.database_now+2592000 then 'player-listing'
           else 'database-clock'
         end clock_source
  from player_clock p cross join database_clock d
),
bot_actor as (
  select id from dune.actors
  where class='Duke' and owner_account_id is null
  order by id limit 1
),
cycle_gate as (
  select s.cycle_id
  from settings s,lock_state l,exchange_state e,game_clock g
  where l.acquired and e.exchange_count=1 and e.inventory_id is not null and g.game_now>0
    and (select access_point_count from selected_access_point)>=1
    and exists(select 1 from bot_actor) and not exists(select 1 from prior_cycle)
),
invalid_tracking as (
  update public.alphanine_market_bot_listings m
  set retired_at=now()
  where m.retired_at is null and exists(select 1 from cycle_gate)
    and not exists (
      select 1
      from dune.dune_exchange_orders o
      join dune.dune_exchange_sell_orders s on s.order_id=o.id
      join dune.items i on i.id=o.item_id and i.id=m.item_id
      join bot_actor b on b.id=o.owner_id
      where o.id=m.order_id and o.is_npc_order=true and o.template_id=m.template_id and i.stack_size>0
    )
  returning m.order_id
),
expired_target as (
  select m.order_id,m.item_id,(o.category_mask<=0 or o.category_depth<=0) invalid_category
  from public.alphanine_market_bot_listings m
  join dune.dune_exchange_orders o on o.id=m.order_id
  join dune.dune_exchange_sell_orders s on s.order_id=o.id
  join dune.items i on i.id=m.item_id and i.id=o.item_id
  join bot_actor b on b.id=o.owner_id
  cross join game_clock g
  where m.retired_at is null and o.is_npc_order=true and o.template_id=m.template_id
    and (o.expiration_time is null or o.expiration_time<=g.game_now or i.stack_size<=0
      or o.category_mask<=0 or o.category_depth<=0)
    and exists(select 1 from cycle_gate)
  for update of o,i
),
deleted_sell as (
  delete from dune.dune_exchange_sell_orders
  where order_id in(select order_id from expired_target)
  returning order_id
),
deleted_orders as (
  delete from dune.dune_exchange_orders
  where id in(select order_id from expired_target)
    and exists(select 1 from deleted_sell)
  returning id
),
deleted_items as (
  delete from dune.items
  where id in(select item_id from expired_target)
    and exists(select 1 from deleted_orders)
  returning id
),
retired_expired as (
  update public.alphanine_market_bot_listings
  set retired_at=now()
  where order_id in(select id from deleted_orders)
  returning order_id
),
valid_managed as (
  select m.order_id,m.item_id,m.template_id,o.expiration_time,i.stack_size
  from public.alphanine_market_bot_listings m
  join dune.dune_exchange_orders o on o.id=m.order_id
  join dune.dune_exchange_sell_orders s on s.order_id=o.id
  join dune.items i on i.id=m.item_id and i.id=o.item_id
  join bot_actor b on b.id=o.owner_id
  where m.retired_at is null and o.is_npc_order=true and o.template_id=m.template_id
    and o.category_mask>0 and o.category_depth>0
    and (select count(*) from invalid_tracking)+(select count(*) from retired_expired)>=0
),
active_counts as (
  select template_id,count(*)::integer active
  from valid_managed v,game_clock g
  where v.stack_size>0 and v.expiration_time>g.game_now
  group by template_id
),
planned as (
  select p.*,coalesce(a.active,0) active_count,greatest(0,p.target_count-coalesce(a.active,0)) deficit
  from policy p left join active_counts a using(template_id)
  where p.target_count>0 and p.category_mask>0 and p.category_depth>0
),
expanded as (
  select p.*,n.ordinal
  from planned p cross join lateral generate_series(1,p.deficit) n(ordinal)
),
category_ranked as (
  select e.*,row_number() over(
    partition by lower(e.category)
    order by lower(e.display_name),e.template_id,e.ordinal
  ) category_sequence
  from expanded e
),
ranked as (
  select e.*,row_number() over(
           order by e.category_sequence,lower(e.category),lower(e.display_name),e.template_id,e.ordinal
         ) sequence,
         sum(e.unit_price*e.stack_size) over(
           order by e.category_sequence,lower(e.category),lower(e.display_name),e.template_id,e.ordinal
         ) cumulative_value
  from category_ranked e
),
approved as (
  select r.*
  from ranked r,settings s
  where r.sequence<=s.max_creates and r.cumulative_value<=s.max_value and exists(select 1 from cycle_gate)
),
next_position as (
  select coalesce(max(position_index),-1) base
  from dune.items where inventory_id=(select inventory_id from exchange_state)
),
inserted_items as (
  insert into dune.items(inventory_id,stack_size,position_index,template_id,quality_level,stats)
  select (select inventory_id from exchange_state),a.stack_size,
         (select base from next_position)+row_number() over(order by a.sequence),
         a.template_id,0,'{"FCustomizationStats":[[],{}],"FItemStackAndDurabilityStats":[[],{}]}'
  from approved a
  order by a.sequence
  returning id,template_id,stack_size,position_index
),
approved_numbered as (
  select a.*,row_number() over(partition by a.template_id,a.stack_size order by a.sequence) match_number
  from approved a
),
items_numbered as (
  select i.*,row_number() over(partition by i.template_id,i.stack_size order by i.position_index) match_number
  from inserted_items i
),
item_plan as (
  select i.id item_id,a.*
  from items_numbered i
  join approved_numbered a using(template_id,stack_size,match_number)
),
inserted_orders as (
  insert into dune.dune_exchange_orders(
    exchange_id,access_point_id,owner_id,is_npc_order,expiration_time,template_id,
    durability_cur,durability_max,category_mask,category_depth,item_price,quality_level,item_id
  )
  select (select exchange_id from exchange_state),(select access_point_id from selected_access_point),
         (select id from bot_actor),true,(select game_now+expiry_seconds from game_clock,settings),
         p.template_id,1.0,1.0,p.category_mask,p.category_depth,p.unit_price,0,p.item_id
  from item_plan p order by p.sequence
  returning id,item_id,template_id,item_price,expiration_time
),
inserted_sell as (
  insert into dune.dune_exchange_sell_orders(order_id,initial_stack_size,wear_normalized_price)
  select o.id,p.stack_size,p.unit_price
  from inserted_orders o join item_plan p on p.item_id=o.item_id
  returning order_id
),
tracked as (
  insert into public.alphanine_market_bot_listings(
    order_id,item_id,template_id,cycle_id,unit_price,stack_size,expiration_time
  )
  select o.id,o.item_id,o.template_id,(select cycle_id from settings),p.unit_price,p.stack_size,o.expiration_time
  from inserted_orders o join item_plan p on p.item_id=o.item_id
  where exists(select 1 from inserted_sell s where s.order_id=o.id)
  returning order_id
),
generated_result as (
  select json_build_object(
    'ok',true,
    'status',case
      when not (select acquired from lock_state) then 'lock-busy'
      when (select exchange_count from exchange_state)<>1 then 'waiting'
      when (select inventory_id from exchange_state) is null then 'waiting'
      when (select access_point_count from selected_access_point)<1 then 'waiting'
      when (select game_now from game_clock)<=0 then 'waiting'
      when not exists(select 1 from bot_actor) then 'waiting'
      else 'completed' end,
    'message',case
      when not (select acquired from lock_state) then 'Another Market Bot cycle holds the database lock.'
      when (select exchange_count from exchange_state)<>1 then 'Waiting for exactly one usable Exchange.'
      when (select inventory_id from exchange_state) is null then 'Waiting for the Exchange inventory.'
      when (select access_point_count from selected_access_point)<1 then 'Waiting for an Exchange access point.'
      when (select game_now from game_clock)<=0 then 'Waiting for a verified Exchange clock.'
      when not exists(select 1 from bot_actor) then 'Waiting for the dedicated Market Bot actor.'
      else format('Restock completed: %%s created, %%s expired or invisible bot-owned listings removed.',
        (select count(*) from tracked),(select count(*) from retired_expired)) end,
    'cycleId',(select cycle_id from settings),
    'mode','execute',
    'exchange',(select exchange_name from exchange_state),
    'gameNow',(select game_now from game_clock),
    'clockSource',(select clock_source from game_clock),
    'created',(select count(*) from tracked),
    'removedExpired',(select count(*) from retired_expired),
    'removedInvalidCategory',(select count(*) from expired_target where invalid_category),
    'retiredInvalid',(select count(*) from invalid_tracking),
    'items',coalesce((select json_agg(json_build_object(
      'id',p.template_id,'name',p.display_name,'category',p.category,'tier',p.tier,'unitPrice',p.unit_price,
      'stackSize',p.stack_size,'targetListings',p.target_count,'activeListings',p.active_count,
      'deficit',p.deficit,'createNow',(select count(*) from item_plan a where a.template_id=p.template_id),
      'plannedValue',p.unit_price*p.stack_size*(select count(*) from item_plan a where a.template_id=p.template_id)
    ) order by lower(p.category),lower(p.display_name),p.template_id) from planned p),'[]'::json),
    'totals',json_build_object(
      'configuredCatalogItems',(select count(*) from policy where target_count>0),
      'catalogItems',(select count(*) from planned),
      'skippedUnknownCategoryMasks',(select count(*) from policy where target_count>0 and (category_mask<=0 or category_depth<=0)),
      'activeListings',coalesce((select sum(active_count) from planned),0),
      'totalDeficit',coalesce((select sum(deficit) from planned),0),
      'created',(select count(*) from tracked),
      'marketValue',coalesce((select sum(unit_price*stack_size) from item_plan),0),
      'maxCreates',(select max_creates from settings),
      'maxMarketValue',(select max_value from settings)
    ),
    'categories',coalesce((
      select json_agg(json_build_object(
        'category',c.category,'items',c.items,'activeListings',c.active_listings,
        'targetListings',c.target_listings,'deficit',c.deficit,'createNow',c.create_now,
        'plannedValue',c.planned_value
      ) order by lower(c.category))
      from (
        select p.category,count(*) items,sum(p.active_count) active_listings,
               sum(p.target_count) target_listings,sum(p.deficit) deficit,
               sum((select count(*) from item_plan a where a.template_id=p.template_id)) create_now,
               sum(p.unit_price*p.stack_size*(select count(*) from item_plan a where a.template_id=p.template_id)) planned_value
        from planned p group by p.category
      ) c
    ),'[]'::json),
    'warning','Only category-verified listings count as active. Existing valid listings are never repriced or reposted. Player listings are never changed.'
  ) result
),
completed_cycle as (
  insert into public.alphanine_market_bot_cycles(cycle_id,mode,completed_at,result)
  select s.cycle_id,s.mode,now(),g.result
  from settings s,generated_result g
  where exists(select 1 from cycle_gate)
  on conflict do nothing
  returning result
),
audit_event as (
  insert into public.alphanine_market_bot_audit(cycle_id,event,details)
  select (select cycle_id from settings),'reconciliation_completed',result
  from generated_result where exists(select 1 from cycle_gate)
  returning id
)
select coalesce(
  (select result::text from prior_cycle),
  (select result::text from completed_cycle),
  (select result::text from generated_result)
);
commit;`, sqlText(cycleID), cfg.Safety.MaxCreatesPerCycle, cfg.Safety.MaxMarketValue,
		int64(cfg.ExpiryDays)*86400, sqlText("alphanine-market-bot:"+cfg.Namespace+":"+cfg.Battlegroup),
		strings.Join(values, ",\n"), exchangePredicate)
}

func sqlText(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func publicConfig(cfg Config) map[string]interface{} {
	return map[string]interface{}{
		"schemaVersion": cfg.SchemaVersion, "runtimeVersion": cfg.RuntimeVersion, "enabled": cfg.Enabled,
		"paused": cfg.Paused, "activated": cfg.Activated, "battlegroup": cfg.Battlegroup,
		"economyStyle": cfg.EconomyStyle, "intervalMinutes": cfg.IntervalMinutes, "expiryDays": cfg.ExpiryDays,
		"listingCategory": cfg.ListingCategory,
		"safety":          cfg.Safety, "itemCount": len(cfg.Items),
	}
}

func stateForConfig(cfg Config, status, message string, last interface{}) State {
	now := time.Now().UTC()
	next := now.Add(time.Duration(cfg.IntervalMinutes) * time.Minute)
	return State{InstalledVersion: runtimeVersion, Status: status, Message: message, LastCycle: last, LastRunAt: now.Format(time.RFC3339), NextRunAt: next.Format(time.RFC3339), UpdatedAt: now.Format(time.RFC3339)}
}

func readState(file string) (State, error) {
	var state State
	body, err := os.ReadFile(file)
	if err != nil {
		return state, err
	}
	return state, json.Unmarshal(body, &state)
}

func writeAtomicJSON(file string, value interface{}, mode os.FileMode) error {
	body, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(file), 0750); err != nil {
		return err
	}
	tmp := file + ".tmp-" + strconv.Itoa(os.Getpid())
	if err := os.WriteFile(tmp, append(body, '\n'), mode); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}

func writeJSON(value interface{}) {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
}

func resultMessage(raw json.RawMessage) string {
	var result map[string]interface{}
	if json.Unmarshal(raw, &result) == nil {
		if value, ok := result["message"].(string); ok {
			return value
		}
	}
	return "Market Bot cycle completed."
}

func flagValue(args []string, name string) string {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == name {
			return args[i+1]
		}
	}
	return ""
}

func isWaitingError(value string) bool {
	lower := strings.ToLower(value)
	return strings.Contains(lower, "waiting for exchange") ||
		strings.Contains(lower, "connection refused") ||
		strings.Contains(lower, "not found") ||
		strings.Contains(lower, "no resources found")
}

func redact(value string) string {
	lines := strings.Split(value, "\n")
	for index, line := range lines {
		lower := strings.ToLower(line)
		if strings.Contains(lower, "password") || strings.Contains(lower, "pgpassword") || strings.Contains(lower, "token") || strings.Contains(lower, "secret") {
			lines[index] = "[redacted sensitive diagnostic]"
		}
	}
	result := strings.TrimSpace(strings.Join(lines, "\n"))
	if len(result) > 2000 {
		result = result[:2000]
	}
	return result
}
