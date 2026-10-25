'use strict';

// V11: native-filtered melee Perfect Parry priority with retained v10 Dodge.
// Respect the game's current selector. A missing native candidate neither
// invokes a cached command nor consumes the source-Step request token.
// Actual submitted requests remain single-shot; no direction/angle rule is added.
if (typeof StellarRuntimeLocator === 'undefined') {
  throw new Error('load tools/runtime/stellar_runtime_locator.js before this candidate');
}

const startupTimingEnabled = globalThis.STELLAR_STARTUP_TRACE === true;
const startupTimings = [];
const startupClock = Date.now();
let startupLastClock = startupClock;
function markStartup(stage) {
  if (!startupTimingEnabled) return;
  const now = Date.now();
  startupTimings.push({stage, elapsedMs:now-startupLastClock, totalMs:now-startupClock});
  startupLastClock = now;
}
function flushStartupTimings() {
  if (startupTimingEnabled) {
    const resolved = [...Object.values(resolvedProfile.functions), ...Object.values(resolvedProfile.sites)].filter(Boolean);
    send({type:'startup_stages',stages:startupTimings,profileResolution:{
      cacheHits:resolved.filter(item=>item.source==='validated_profile_cache').length,
      aobScans:resolved.filter(item=>item.source==='aob_scan').length,
    }});
  }
}

const locator = StellarRuntimeLocator;
const resolvedProfile = locator.resolveKnownProfile();
markStartup("profile_resolved");
const runtimeSession = locator.createRuntimeSession(resolvedProfile);
const compatibilityResolver=locator.createCompatibilityResolver(resolvedProfile);
const capabilities={};
const compatibilityWarnings=[];
function nativeSite(name){return compatibilityResolver.resolve(name);}
function nativeAddress(name){return nativeSite(name).address;}
function prepareCompatibility(){
  const groups={
    core:['dataManager','skillRowLookup','filterRowLookup','commandRowLookup','skillAliasLookup','movement','movementSelect','meleeSourceGate','meleeAngle','meleeResolution','meleeConsumer','useActiveResolverCall'],
    special:['dataManager','skillRowLookup','filterRowLookup','targetQuery','freeArray'],
    effect:['dataManager','effectAliasLookup','effectApply','effectGather','effectJust','effectGatherCall','effectJustCall'],
    health:['healthMutation'],
    inputPriority:['prioritySelectorCall','priorityUseCall'],
    diagnostics:['useActiveResolverCall','useDataManagerCall','useRequestedRowCall','useActorRestrictionCall','useCommandGateCall','useRefusalMarker'],
  };
  if(typeof nativeGuardConfig!=='undefined'){
    groups.guard=['initialStepResolver','dataManager','skillRowLookup','filterRowLookup','targetQuery','freeArray'];
    groups.projectileGuard=['projectileRowLookup','projectileGeometry','actorState','projectileStateCall'];
  }
  for(const [name,sites] of Object.entries(groups)){
    try{sites.forEach(nativeSite);capabilities[name]={available:true,enabled:false};}
    catch(error){
      capabilities[name]={available:false,enabled:false,reason:String(error)};
      if(name==='core')throw new Error('Core native compatibility validation failed: '+String(error));
      compatibilityWarnings.push({capability:name,message:String(error)});
    }
  }
  nativeConfigureRepeatSources(resolvedProfile.functions.getLogicManagerHost.address,nativeSite('useActiveResolverCall').target);
}
function enableCapability(name,install,rollback){
  if(!capabilities[name]?.available)return false;
  try{install();capabilities[name].enabled=true;return true;}
  catch(error){
    try{rollback();Interceptor.flush();}
    catch(cleanupError){throw new Error(name+' could not restore its partial installation: '+String(cleanupError));}
    capabilities[name]={available:false,enabled:false,reason:String(error)};
    compatibilityWarnings.push({capability:name,message:String(error)});return false;
  }
}
function snapshotCompatibility(){
  return {...compatibilityResolver.snapshot(),capabilities:{...capabilities},warnings:compatibilityWarnings,
    optionalLocatorFailures:resolvedProfile.optionalUnavailable||{}};
}
function snapshotCommandDiscovery(){
  return {evadeSkillIds:[...activeEvadeSkillIds],guardSkillIds:[...activeGuardSkillIds],
    errors:commandDiscoveryErrors,overflow:commandDiscoveryOverflow,capacity:MAX_ACTION_CANDIDATES,maxCommandNodes:MAX_COMMAND_NODES};
}
function snapshotBindingStatus(){
  if(bindingReady){
    if(globalThis.STELLAR_OBSERVE_ONLY===true)return {stage:'ready',code:'observation.ready',message:'观察已连接（不执行自动动作）'};
    if(globalThis.STELLAR_DODGE_DISABLED===true &&
       (globalThis.STELLAR_GUARD_DISABLED===true || !capabilities.guard?.enabled) &&
       (globalThis.STELLAR_SPECIAL_DISABLED===true || !capabilities.special?.enabled))
      return {stage:'capability',code:'features.unavailable',message:'角色已连接，但所选功能在此版本不可用'};
    const partial=compatibilityWarnings.filter(x=>{
      if(['health','diagnostics'].includes(x.capability))return false;
      if(x.capability==='special' && globalThis.STELLAR_SPECIAL_DISABLED===true)return false;
      if(['guard','projectileGuard'].includes(x.capability) && globalThis.STELLAR_GUARD_DISABLED===true)return false;
      if(x.capability==='effect' && globalThis.STELLAR_DODGE_DISABLED===true)return false;
      return true;
    });
    return {stage:'ready',code:partial.length?'features.partial':'features.ready',
      message:partial.length?'基础辅助已开启；部分功能未通过兼容校验':'角色已绑定，辅助已开启'};
  }
  const player=runtimeSession.getBindingStatus();
  return player.code==='player.ready'
    ? {stage:'binding',code:'actions.unavailable',message:'已找到角色，等待可用的闪避动作；请进入可操作角色的场景'}
    : player;
}

markStartup("runtime_session_created");
const EVADE_INPUT_ID = locator.INPUT_IDS.evade;
const EVADE_SKILL_CANDIDATES = Object.freeze([
  1001102, // Sword normal Perfect-Dodge source
  1001105, // Sword lock-on Perfect-Dodge source
  1004201, // Tachy normal
  1004202, // Tachy lock-on
  1007101, // Fusion normal
  1007102, // Fusion lock-on
  6010255, // Scarlet normal (Scarlet / Raven Stances 1.1)
  6010256, // Scarlet lock-on
  6020269, // Raven normal
  6020270, // Raven lock-on
]);
const MAX_ACTION_CANDIDATES = 64;
const NATIVE_STATE_CAPACITY = 131072;
const MAX_COMMAND_NODES = 4096;
const MELEE_DIAG_CAPACITY = 32;
const BINDING_REFRESH_MS = 500;

const nativeSource = String.raw`
#include <gum/guminterceptor.h>
typedef unsigned char u8;
typedef unsigned int u32;
typedef unsigned long long u64;
#define NATIVE_ELIGIBILITY_V5 1

typedef void *(*use_skill_t)(void *, u32, void *, void *, u8, u8, u64, u8, void *, u8, void *, u8);
typedef u8 (*update_skill_t)(void *, float);
typedef u8 (*deactivate_skill_t)(void *, u8);
typedef void *(*select_command_node_t)(void *, u32, u32, float, u32);
typedef u32 (*melee_t)(void *, void *, void *, void *);
typedef u8 (*projectile_t)(void *, void *, void *, void *);
typedef u8 (*hit_records_t)(void *, void *, void *);
typedef void *(*find_actor_t)(void *, const void *);
typedef void *(*logic_manager_host_t)(void);
typedef void *(*active_resolver_t)(void *, u32);

extern unsigned char shared_state[];
extern void *melee_original_slot;
extern void *projectile_original_slot;
extern void *hit_records_original_slot;
extern void *update_original_slot;
extern void *movement_original_slot;
extern void *movement_select_original_slot;
typedef u64 (*movement_native_t)(void*,u32,void*,void*,void*,void*,void*,u8,float);
typedef u8 (*movement_select_native_t)(void*,void*,void*,void*,void*,void*,void*,void*,void*,void*,u64,void*,void*,void*,void*,void*,void*,void*,float,void*,void*);
#define movement_original ((movement_native_t)movement_original_slot)
#define movement_select_original ((movement_select_native_t)movement_select_original_slot)
extern void *gum_invocation_context_get_nth_argument(GumInvocationContext *, u32);
extern void *gum_invocation_context_get_return_address(GumInvocationContext *);
extern void *gum_invocation_context_get_return_value(GumInvocationContext *);
extern void gum_invocation_context_replace_return_value(GumInvocationContext *, void *);
extern void *gum_invocation_context_get_listener_invocation_data(GumInvocationContext *, u64);
extern u32 GetCurrentThreadId(void);

enum {
  LOGIC_RUNTIME_ID = 0x5d0,
  ACTOR_COMMAND_MANAGER = 0x530,
  COMMAND_NODE_INPUT_ID = 0x18,
  COMMAND_NODE_FNAME = 0x24,
  EVADE_INPUT_ID = 24,
  SKILL_CURRENT_STEP = 0x60,
  SKILL_PERFECT_WINDOW = 0xb8,
  SKILL_ACTIVE = 0xc0,
  SKILL_DELAYED_COUNT = 0x1d0,
  SKILL_DELAYED_FIRST_STEP = 0x1d4,
  SKILL_RESULT_EPOCH = 0x23c,
  SKILL_RESULT_MAP = 0x108,
  STEP_ID = 0x10,
  STEP_TYPE = 0x14,
  PROJECTILE_RUNTIME_ID = 0x20,
  HIT_RECORD_STRIDE = 0x150,
  HIT_RECORD_LIMIT = 64,
  PROJECTILE_WAITING = 1,
  PROJECTILE_RELEASED = 2,
  PROJECTILE_SETTLED = 3,
  PROJECTILE_FAIL_OPEN = 4,
  PROJECTILE_REARM_WAITING = 5,
  PROJECTILE_PENDING = 6,
  ACTION_CANDIDATE_CAPACITY = 64,
  MELEE_DIAG_CAPACITY = 32,
  FILTER_THREAD_SLOTS = 64,
  MELEE_TOKEN_CAPACITY = 128,
  PROJECTILE_TOKEN_CAPACITY = 256
};

struct melee_token {
  void *source;
  void *step;
  u32 generation;
  u32 source_epoch;
};

struct action_candidate {
  u32 skill_id;
  u32 reserved;
  u64 command_key;
};

struct projectile_token {
  void *projectile;
  void *target_actor;
  u32 generation;
  u32 projectile_id;
  u32 state;
  u32 gate_seen;
  u64 natural_updates_at_claim;
  u32 pending;
  u32 pending_reserved;
  void *pending_active_skill;
  void *pending_step;
  u32 pending_runtime;
  u32 pending_generation;
  u32 pending_repeat_eligible;
  u32 pending_step239;
  u32 pending_step240;
};

struct repeat_phase {
  void *active_skill;
  void *step;
  u32 runtime;
  u32 state;
  u32 repeat_eligible;
  u32 step239;
  u32 step240;
};

struct melee_pending {
  u32 active;
  u32 generation;
  u32 source_epoch;
  u32 player_runtime;
  void *source;
  void *source_step;
  void *player_logic;
  void *active_skill;
  void *active_step;
  u32 active_state;
  u32 repeat_eligible;
  u32 step239;
  u32 step240;
};

struct melee_diag {
  void *source;
  void *step;
  u32 generation;
  u32 step_id;
  u32 step_type;
  u32 source_epoch;
  u64 calls;
  u64 blocked_active;
  u64 duplicate_suppressed;
  u64 requests;
  u64 installed;
  u64 last_result;
  u64 native_stops;
  u64 stop_confirmed;
  u64 stop_failed;
  u64 restart_attempts;
  u64 restart_installed;
  u64 restart_rejected;
  u64 epoch_after;
  u64 interaction;
  u64 interaction_class;
  u64 out_accepted;
  u64 selector_returned;
  u64 selector_fallback_used;
  u64 request_returned_nonnull;
  u64 request_returned_null;
  u64 runtime_changed;
  u64 pending_state;
  u64 forced_bfd340_issued;
  u64 active_state;
  u64 current_step_established;
  u64 old_owned_active;
  u64 natural_bfd340_seen;
  u64 token_expirations;
  u64 accepted_true;
  u64 accepted_false;
  u64 source_gate_calls;
  u64 source_gate_true;
  u64 source_gate_false;
  u64 available_just_action;
  u64 attempt_sequence;
  u64 attempt_installed;
  u64 attempt_accepted;
  u64 runtime_before_request;
  u64 runtime_after_request;
  u64 owned_snapshot_valid;
  u64 owned_step_id;
  u64 owned_step_type;
  u64 owned_window_bits;
  u64 owned_target_count;
  u64 source_actor_key;
  u64 source_in_owned_targets;
  u64 result_step_id;
  u64 result_window_bits;
  u64 defender_gate_seen;
  u64 defender_gate_passed;
  u64 owned_row_alias_110;
  u64 angle_probe_seen;
  u64 angle_result_al;
  u64 angle_source_match;
  u64 angle_defender_match;
  u64 angle_threshold_bits;
  u64 angle_source_ptr;
  u64 angle_defender_ptr;
  u64 just_consumer_calls;
  u64 just_consumer_matched;
  u64 just_consumer_completed;
  u64 just_consumer_result_type;
  u64 just_consumer_descriptor;
  u64 just_consumer_step_id;
  u64 just_consumer_step_type;
  u64 just_resolution_seen;
  u64 just_resolution_descriptor;
  u64 just_resolution_step_id;
  u64 just_resolution_step_type;
  u64 native_selector_deferred;
  u64 native_request_submitted;
};

struct lease {
  void *skill_logic;
  void *step;
  u32 runtime;
  float original;
  int active;
  int attempted;
};
struct melee_call_context {
  u32 thread_id;
  u32 generation;
  u32 active;
  u32 source_epoch;
  u32 gate_kind;
  u32 gate_key;
  void *source;
  void *step;
  void *target;
  struct melee_diag *diag;
  struct lease *lease;
};

struct builder_thread_slot {
  u32 thread_id;
  u32 generation;
  void *projectile;
  void *data;
  u32 count;
  u32 projectile_id;
  u64 sequence;
  u32 secondary_count;
  u32 reserved;
};

struct actor_resolve_slot {
  u32 thread_id;
  u32 active;
  void *projectile;
  void *record;
  u32 projectile_id;
  u32 reserved;
  u64 sequence;
};

// BEF780 and C08B40 run on the same game thread. This per-thread context is
// intentionally scoped to one native arbitration call; hit-record discovery
// is not a ranged action-start condition.
struct projectile_gate_slot {
  u32 thread_id;
  u32 active;
  void *projectile;
  void *target_logic;
  u32 projectile_id;
  u32 gate_seen;
  u32 generation;
  u32 reserved;
};

struct melee_pair_slot {
  u32 thread_id;
  u32 active;
  void *target_group;
  u32 generation;
  u32 attempted;
  u32 installed;
  u32 reserved;
};

struct just_probe_invocation {
  u32 active;
  u32 generation;
  u32 thread_id;
  u32 runtime;
  u64 sequence;
  struct melee_diag *diag;
  void *owned;
  void *source;
  void *step;
};

// CModule data pages may be read-only. All mutable state belongs to this
// JS-owned RW block and is supplied through the shared_state extern symbol.
struct shared_state {
  volatile u32 ready;
  u32 generation;
  void *player_actor;
  void *player_logic;
  void *actor_manager;
  void *player_collision_group;
  volatile u32 action_candidate_count;
  u32 selected_action_index;
  struct action_candidate action_candidates[ACTION_CANDIDATE_CAPACITY];
  void *use_skill;
  void *update_skill;
  void *deactivate_skill;
  void *select_command_node;
  void *find_actor;
  void *logic_manager_host;
  void *active_resolver;
  void *owned_evade;
  u32 owned_runtime;
  u32 owned_diag_reserved;
  struct melee_diag *owned_diag;
  void *owned_diag_source;
  void *owned_diag_step;
  volatile u32 injecting;
  u32 melee_cursor;
  u32 projectile_cursor;
  u32 melee_token_count;
  struct melee_call_context melee_call_contexts[FILTER_THREAD_SLOTS];
  struct melee_token melee_tokens[MELEE_TOKEN_CAPACITY];
  struct projectile_token projectile_tokens[PROJECTILE_TOKEN_CAPACITY];
  u32 melee_diag_cursor;
  u32 melee_diag_reserved;
  struct melee_diag melee_diag[MELEE_DIAG_CAPACITY];
  void *filtered_actor_caller_return;
  void *projectile_eligibility_gate_caller_return;
  void *melee_pair_caller_return;
  struct builder_thread_slot builder_slots[FILTER_THREAD_SLOTS];
  struct actor_resolve_slot actor_resolve_slots[FILTER_THREAD_SLOTS];
  struct projectile_gate_slot gate_slots[FILTER_THREAD_SLOTS];
  struct melee_pair_slot melee_pair_slots[FILTER_THREAD_SLOTS];
  void *angle_probe_site;
  void *just_consumer;
  void *just_consumer_return;
  float location[4];
  float direction[4];
  volatile u64 attempts;
  volatile u64 installed;
  volatile u64 rejected;
  volatile u64 melee_calls;
  volatile u64 hit_builder_calls;
  volatile u64 player_matches;
  volatile u64 action_claims;
  volatile u64 projectile_calls;
  volatile u64 deferred_hits;
  volatile u64 retry_hits;
  volatile u64 hit_builder_sequence;
  void *deferred_projectile;
  void *ranged_wait_evade;
  u32 ranged_wait_runtime;
  u32 ranged_wait_reserved;
  u64 deferred_builder_sequence;
  u64 current_player_builder_sequence;
  volatile u64 same_builder_result_calls;
  volatile u64 later_builder_result_calls;
  volatile u64 primary_num_at_defer;
  volatile u64 secondary_num_at_defer;
  volatile u64 owned_natural_updates;
  volatile u64 waiting_defers;
  volatile u64 released_after_update;
  volatile u64 fail_open_releases;
  volatile u64 blocked_projectile_leases;
  volatile u64 released_result_calls;
  volatile u64 rearmed_attacks;
  volatile u64 native_stops;
  volatile u64 stop_confirmed;
  volatile u64 stop_failed;
  volatile u64 restart_attempts;
  volatile u64 restart_installed;
  volatile u64 restart_rejected;
  volatile u64 gate_true_seen;
  volatile u64 gate_suppressed;
  volatile u64 same_projectile_gate_reentered;
  volatile u64 released_original_true;
  volatile u64 melee_pair_true_seen;
  volatile u64 melee_pair_requests;
  volatile u64 melee_pair_installed;
  volatile u64 melee_pair_consumed;
  volatile u64 selector_returned;
  volatile u64 selector_fallback_used;
  volatile u64 request_returned_nonnull;
  volatile u64 request_returned_null;
  volatile u64 runtime_changed;
  volatile u64 pending_state;
  volatile u64 forced_bfd340_issued;
  volatile u64 active_state;
  volatile u64 current_step_established;
  volatile u64 old_owned_active;
  volatile u64 natural_bfd340_seen;
  volatile u64 pending_created;
  volatile u64 pending_deferrals;
  volatile u64 pending_rechecks;
  volatile u64 installed_after_wait;
  volatile u64 pending_invalidated;
  u32 melee_pending_cursor;
  struct melee_pending melee_pending[MELEE_DIAG_CAPACITY];
  void *melee_source_gate_caller_return;
  struct melee_diag ranged_request_diag;
  u64 native_selector_deferred;
  void *initialization_trace;
  u32 source_direction_enabled;
  u32 source_direction_reserved;
  void *request_source_actor;
  u64 source_direction_requests;
  u64 source_direction_unavailable;
  u64 source_direction_selector_queries;
  void *movement_trace;
  void *movement_scope;
  void *initialization_active_record;
  void *action_trace_update;
  void *action_trace_before;
  void *action_trace_after;
  u32 effective_input_enabled;
  u32 ordinary_direction_request;
  void *action_data_manager;
  void *action_skill_lookup;
  void *action_command_lookup;
  void *action_alias_lookup;
  void *action_step_lookup;
  volatile u32 guard_candidate_count;
  struct action_candidate guard_candidates[ACTION_CANDIDATE_CAPACITY];
  void *guard_expected_row;
  void *guard_captured_step;
  u64 guard_expected_filter;
  u64 guard_request_nonce;
  u32 guard_request_thread;
  u32 guard_request_generation;
  u32 guard_capture_count;
  u32 guard_capture_conflict;
  void *guard_data_manager;
  void *guard_skill_lookup;
  void *guard_step_lookup;
  void *guard_target_query;
  void *guard_free;
  u32 guard_enabled;
  u32 guard_request_active;
  u32 owned_guard;
  u32 owned_guard_release_attempted;
  u32 guard_draining;
  u32 guard_unexpected_step;
  u32 dodge_disabled;
  struct action_candidate guard_candidate;
  u64 guard_stats[16];
  void *projectile_guard_row_lookup;
  void *projectile_guard_geometry;
  void *projectile_guard_actor_state;
  u64 projectile_guard_stats[12];
  void *special_data_manager;
  void *special_skill_lookup;
  void *special_step_lookup;
  void *special_target_query;
  void *special_free;
  void *special_clock;
  u32 special_allowed;
  u32 special_enabled;
  u32 special_generation;
  u32 special_poll_running;
  u32 special_poll_clock_valid;
  u32 special_active_snapshot;
  u64 special_last_poll;
  u64 special_polls;
  u64 special_selector_queries;
  u64 special_qualified;
  u64 special_requests;
  u64 special_returned_null;
  u64 special_blue;
  u64 special_purple;
  u64 special_max_poll_ms;
  u64 special_total_poll_ms;
  u64 special_binding_changed;
  u32 special_last_skill_id;
  u32 special_latched_skill_id;
  u64 special_latched_key;
  void *special_latched_target;
  u64 special_tracked_runtime;
  void *special_tracked_skill;
  u64 special_tracked_key;
  void *special_tracked_target;
  u64 special_initial_step;
  u64 special_latest_step;
  void *effect_state;
  void *health_state;

};

#define S ((struct shared_state *)shared_state)
#define g_ready (S->ready)
#define g_generation (S->generation)
#define g_player_actor (S->player_actor)
#define g_player_logic (S->player_logic)
#define g_actor_manager (S->actor_manager)
#define g_player_collision_group (S->player_collision_group)
#define g_action_candidate_count (S->action_candidate_count)
#define g_selected_action_index (S->selected_action_index)
#define g_action_candidates (S->action_candidates)
#define g_use_skill ((use_skill_t)S->use_skill)
#define g_update_skill ((update_skill_t)S->update_skill)
#define g_deactivate_skill ((deactivate_skill_t)S->deactivate_skill)
#define g_select_command_node ((select_command_node_t)S->select_command_node)
#define g_find_actor ((find_actor_t)S->find_actor)
#define g_logic_manager_host (S->logic_manager_host)
#define g_active_resolver (S->active_resolver)
#define g_owned_evade (S->owned_evade)
#define g_owned_runtime (S->owned_runtime)
#define g_injecting (S->injecting)
#define g_melee_tokens (S->melee_tokens)
#define g_melee_cursor (S->melee_cursor)
#define g_projectile_tokens (S->projectile_tokens)
#define g_projectile_cursor (S->projectile_cursor)
#define g_melee_diag (S->melee_diag)
#define g_melee_diag_cursor (S->melee_diag_cursor)
#define g_filtered_actor_caller_return (S->filtered_actor_caller_return)
#define g_projectile_eligibility_gate_caller_return (S->projectile_eligibility_gate_caller_return)
#define g_melee_pair_caller_return (S->melee_pair_caller_return)
#define g_melee_source_gate_caller_return (S->melee_source_gate_caller_return)
#define g_builder_slots (S->builder_slots)
#define g_actor_resolve_slots (S->actor_resolve_slots)
#define g_location (S->location)
#define g_direction (S->direction)
#define g_angle_probe_site (S->angle_probe_site)
#define g_just_consumer (S->just_consumer)
#define g_just_consumer_return (S->just_consumer_return)
#define g_melee_original ((melee_t)melee_original_slot)
#define g_projectile_original ((projectile_t)projectile_original_slot)
#define g_hit_records_original ((hit_records_t)hit_records_original_slot)
#define g_update_original ((update_skill_t)update_original_slot)

static u32 read_u32(void *base, u32 offset) {
  return *(u32 *)((u8 *)base + offset);
}

static u64 read_u64(void *base, u32 offset) {
  return *(u64 *)((u8 *)base + offset);
}

static void write_u32(void *base, u32 offset, u32 value) {
  *(u32 *)((u8 *)base + offset) = value;
}

static u8 read_u8(void *base, u32 offset) {
  return *(u8 *)((u8 *)base + offset);
}

static void write_u8(void *base, u32 offset, u8 value) {
  *(u8 *)((u8 *)base + offset) = value;
}

static void *read_pointer(void *base, u32 offset) {
  return *(void **)((u8 *)base + offset);
}

static float read_f32(void *base, u32 offset) {
  return *(float *)((u8 *)base + offset);
}

static void write_f32(void *base, u32 offset, float value) {
  *(float *)((u8 *)base + offset) = value;
}



typedef void *(*action_manager_t)(void);
typedef void *(*action_id_lookup_t)(void*,void*,u32);
typedef void *(*action_command_lookup_t)(void*,void*,void*);
typedef void *(*action_alias_lookup_t)(void*,void*,u64);
static int finite_input_float(float f);
void configure_action_rows(void *manager,void *by_id,void *command,void *by_alias,void *step) {
  S->action_data_manager=manager;S->action_skill_lookup=by_id;
  S->action_command_lookup=command;S->action_alias_lookup=by_alias;S->action_step_lookup=step;
}
static int initialize_action_row(void *row) {
  void *vtable,*initialize;
  if(!row)return 0;
  if(read_u8(row,8)==1)return 1;
  if(read_u8(row,8)!=0)return 0;
  vtable=read_pointer(row,0);initialize=vtable?read_pointer(vtable,0x20):0;
  if(!initialize)return 0;
  // Same lazy initialization as the native Command eligibility caller.
  write_u8(row,8,1);((void(*)(void*))initialize)(row);
  return read_u8(row,8)==1;
}
static void *current_action_row(u32 id) {
  void *manager,*table,*row;
  if(!id || !S->action_data_manager || !S->action_skill_lookup)return 0;
  manager=((action_manager_t)S->action_data_manager)();
  table=manager?read_pointer(manager,0x20):0;
  row=table?((action_id_lookup_t)S->action_skill_lookup)(table,0,id):0;
  if(!initialize_action_row(row) || read_u32(row,0x10)!=id)return 0;
  return row;
}
static int has_native_just_capability(void *row) {
  float normal,story;void *manager,*step;u64 alias;
  if(!row || !S->action_data_manager || !S->action_step_lookup)return 0;
  alias=read_u64(row,0x110);if(!alias)return 0;
  manager=((action_manager_t)S->action_data_manager)();
  step=manager?((action_command_lookup_t)S->action_step_lookup)(manager,0,&alias):0;
  if(!step || read_u8(step,8)!=1 || !read_u32(step,0x10))return 0;
  normal=read_f32(row,0x108);story=read_f32(row,0x10c);
  return finite_input_float(normal) && finite_input_float(story) &&
    (normal>0.0f || story>0.0f);
}
static int is_special_response_id(u32 id) {
  return id==1001501 || id==1001502 || id==1001503 || id==1001504 ||
    id==1001521 || id==1001522;
}
static int action_row_qualifies(void *row,u32 input) {
  u32 id;
  if(!row || !has_native_just_capability(row))return 0;
  id=read_u32(row,0x10);
  if(!id || is_special_response_id(id))return 0;
  if(input==EVADE_INPUT_ID)return read_u8(row,0x75)==4;
  // The guard path additionally checks its actual initial step and filter.
  return input==26 && read_u8(row,0x75)!=4;
}
u32 qualify_action_id(u32 id,u32 input) {
  return action_row_qualifies(current_action_row(id),input);
}
u32 read_command_action(void *node,u32 input,u64 *out) {
  void *manager,*table,*command,*row;u64 alias,key;
  if(!node || !out || read_u32(node,COMMAND_NODE_INPUT_ID)!=input ||
     !S->action_data_manager || !S->action_command_lookup || !S->action_alias_lookup)return 0;
  key=read_u64(node,COMMAND_NODE_FNAME);if(!key)return 0;
  manager=((action_manager_t)S->action_data_manager)();
  if(!manager)return 0;
  command=((action_command_lookup_t)S->action_command_lookup)(manager,0,(u8*)node+COMMAND_NODE_FNAME);
  if(!command || read_u8(command,8)!=1)return 0;
  // +0x20 is a PriorityRow alias, not another SkillAlias. Never guess its ID.
  alias=read_u64(command,0x18);table=read_pointer(manager,0x20);
  if(!alias || !table)return 0;
  row=((action_alias_lookup_t)S->action_alias_lookup)(table,0,alias);
  if(!initialize_action_row(row) || !action_row_qualifies(row,input))return 0;
  out[0]=read_u32(row,0x10);out[1]=key;out[2]=read_u32(node,0x2c);out[3]=input;
  return 1;
}

u32 extend_action_candidates(void *actor,void *logic,u32 generation,
    struct action_candidate *evades,u32 evade_count,
    struct action_candidate *guards,u32 guard_count) {
  u32 i,j,count,flags=0;
  if(!g_ready || actor!=g_player_actor || logic!=g_player_logic || generation!=g_generation ||
     evade_count>ACTION_CANDIDATE_CAPACITY || guard_count>ACTION_CANDIDATE_CAPACITY ||
     (evade_count&&!evades) || (guard_count&&!guards))return 8;
  // In a stable player generation, add slots without changing any existing
  // slot/index/owner/token. x64 aligned volatile counts are committed only
  // after the new slots are fully written. Readers may keep their old set.
  count=g_action_candidate_count;
  for(i=0;i<evade_count;i++) {
    if(!evades[i].skill_id || !evades[i].command_key)continue;
    for(j=0;j<count;j++)if(g_action_candidates[j].skill_id==evades[i].skill_id)break;
    if(j<count)continue;
    if(count==ACTION_CANDIDATE_CAPACITY){flags|=4;continue;}
    g_action_candidates[count++]=evades[i];flags|=1;
  }
  g_action_candidate_count=count;
  count=S->guard_candidate_count;
  for(i=0;i<guard_count;i++) {
    if(!guards[i].skill_id || !guards[i].command_key)continue;
    for(j=0;j<count;j++)if(S->guard_candidates[j].skill_id==guards[i].skill_id)break;
    if(j<count)continue;
    if(count==ACTION_CANDIDATE_CAPACITY){flags|=4;continue;}
    S->guard_candidates[count++]=guards[i];flags|=2;
  }
  S->guard_candidate_count=count;
  return flags;
}

void configure_guard_candidates(struct action_candidate *candidates,u32 count) {
  u32 i;S->guard_candidate_count=0;
  if(count>ACTION_CANDIDATE_CAPACITY || (!candidates&&count))return;
  for(i=0;i<count;i++)S->guard_candidates[i]=candidates[i];
  S->guard_candidate_count=count;
}

// Diagnostic records are separate from action state; no diagnostic decision
// changes a native argument, action request, movement, window or result.
struct init_snapshot { u64 v[10]; };
struct init_record { u64 h[16]; struct init_snapshot phase[6]; u64 requested_direction[3]; u64 request_source; };
struct init_trace { u64 next, event; struct init_record rows[32]; };
#define IT ((struct init_trace*)S->initialization_trace)
void read_action_trace_context(u64 *out) {
  u32 generation=g_generation;
  struct init_record *r=(struct init_record*)S->initialization_active_record;
  u64 sequence=r?r->h[0]:0;
  out[0]=g_ready;out[1]=generation;out[2]=(u64)g_player_actor;
  out[3]=(u64)g_player_logic;out[4]=g_injecting;
  out[5]=r && r->h[1]==generation && r->h[2]==GetCurrentThreadId() &&
    S->initialization_active_record==r && r->h[0]==sequence ? sequence:0;
  if(g_generation!=generation || out[2]!=(u64)g_player_actor ||
     out[3]!=(u64)g_player_logic){out[0]=0;out[5]=0;}
}

void read_priority_context(u64 *out) {
  out[0]=g_ready; out[1]=g_generation; out[2]=(u64)g_player_actor; out[3]=(u64)g_player_logic;
  out[4]=g_injecting; out[5]=0; out[6]=(u64)g_owned_evade;
  out[7]=g_owned_runtime; out[8]=(u64)S->special_tracked_skill; out[9]=S->special_tracked_runtime;
  out[10]=S->special_generation; out[11]=S->special_enabled;
  if(!g_ready || out[1]!=g_generation || out[2]!=(u64)g_player_actor ||
     out[3]!=(u64)g_player_logic)out[0]=0;
}
void set_action_trace_update(void *fn) {S->action_trace_update=fn;}
void set_action_trace_automatic(void *before,void *after) {
  S->action_trace_before=before;S->action_trace_after=after;
}
static u32 init_float_bits(float f) { union {float f;u32 u;} b;b.f=f;return b.u; }
void configure_initialization_trace(void *p) { S->initialization_trace=p; }
u32 initialization_record_size(void) {return sizeof(struct init_record);}
u32 initialization_trace_size(void) {return sizeof(struct init_trace);}
static void init_capture(struct init_record *r,u32 phase,void *skill) {
  struct init_snapshot *v; void *step; u32 i;
  if(!IT || !r || phase>=6 || !g_player_logic || r->h[1]!=g_generation)return;
  v=&r->phase[phase];for(i=0;i<10;i++)v->v[i]=0;
  v->v[0]=read_u32(g_player_logic,LOGIC_RUNTIME_ID);
  v->v[6]=read_u64(g_player_logic,0x78);
  v->v[7]=read_u32(g_player_logic,0x84);
  v->v[8]=read_u32(g_player_logic,0x88);
  v->v[9]=read_u32(g_player_logic,0x8c);
  if(skill && read_pointer(skill,0x68)==g_player_logic) {
    v->v[1]=(u64)skill;step=read_pointer(skill,SKILL_CURRENT_STEP);
    v->v[2]=step?read_u32(step,STEP_ID):0;v->v[3]=read_u8(skill,SKILL_ACTIVE);
    v->v[4]=read_u32(skill,SKILL_PERFECT_WINDOW);
    v->v[5]=read_u32(skill,SKILL_DELAYED_COUNT);
  }
  r->h[8]|=((u64)1<<phase);
}
static struct init_record *init_begin(u32 skill_id,u64 key,struct melee_diag *diag) {
  struct init_record *r;u64 n;u32 i;
  if(!IT || !g_ready || !g_player_logic)return 0;
  n=++IT->next;r=&IT->rows[(n-1)%32];
  for(i=0;i<sizeof(*r)/sizeof(u64);i++)((u64*)r)[i]=0;
  r->h[1]=g_generation;r->h[2]=GetCurrentThreadId();r->h[3]=S->attempts;
  r->h[4]=skill_id;r->h[5]=key;r->h[6]=diag?(u64)diag->source:0;
  r->h[7]=diag?diag->step_id:0;r->h[12]=2;
  init_capture(r,0,0);r->h[0]=n;return r;
}
static struct init_record *init_find(void *skill) {
  u32 i;struct init_record *r;u32 runtime;
  if(!IT || !g_ready || !skill || !g_player_logic || skill!=g_owned_evade)return 0;
  runtime=read_u32(g_player_logic,LOGIC_RUNTIME_ID);
  if(!runtime || runtime!=g_owned_runtime)return 0;
  for(i=0;i<32;i++){
    r=&IT->rows[i];
    if(r->h[0] && r->h[1]==g_generation && (r->h[8]&4) &&
      r->phase[2].v[0]==runtime && r->phase[2].v[1]==(u64)skill)return r;
  }
  return 0;
}
static struct init_record *init_natural_before(void *skill,float delta) {
  struct init_record *r=init_find(skill);
  if(!r || (r->h[8]&8))return 0;
  r->h[10]=GetCurrentThreadId();r->h[11]=init_float_bits(delta);
  r->h[14]=++IT->event;init_capture(r,3,skill);return r;
}
static void init_natural_after(struct init_record *r,u64 sequence,void *skill) {
  if(!IT || !r || r->h[0]!=sequence || r->h[1]!=g_generation)return;
  // The original update may retire the runtime; do not dereference an old
  // skill then. Actor-only snapshot preserves that identity departure.
  if(!g_player_logic || read_u32(g_player_logic,LOGIC_RUNTIME_ID)!=r->phase[3].v[0])skill=0;
  init_capture(r,4,skill);
}
static void init_angle(void *skill,u32 al) {
  struct init_record *r=init_find(skill);
  if(!r || (r->h[8]&32))return;
  r->h[12]=al;r->h[15]=++IT->event;init_capture(r,5,skill);
}
u32 read_initialization_trace(void *out) {
  u32 i,j;u64 before,mask;struct init_record *dst=out;
  if(!IT)return 0;
  for(i=0;i<32;i++){
    before=*(volatile u64*)&IT->rows[i].h[0];
    mask=*(volatile u64*)&IT->rows[i].h[8];
    for(j=0;j<sizeof(struct init_record)/sizeof(u64);j++)((u64*)&dst[i])[j]=((u64*)&IT->rows[i])[j];
    if(before!=*(volatile u64*)&IT->rows[i].h[0] || mask!=*(volatile u64*)&IT->rows[i].h[8])dst[i].h[0]=0;
  }
  return 32;
}


// Read-only movement-selection trace. BA2E40 and BE3BC0 are observed only
// while a trainer-owned UseSkill update is executing for the current player.
struct movement_trace_row {
  u64 sequence;
  u64 generation;
  u64 thread;
  u64 initialization_sequence;
  u64 ba2e40_calls;
  u64 be3bc0_calls;
  u64 actor;
  u64 input_arg;
  u64 row;
  u64 self_pos;
  u64 game_input;
  u64 direction;
  u64 output_movement;
  u64 row_60;
  u64 row_3a;
  u64 row_6c;
  u64 row_90;
  u64 row_94;
  u64 row_98;
  u64 row_9c;
  u64 self_front[3];
  u64 self_right[3];
  u64 self_up[3];
  u64 input_values[3];
  u64 direction_values[3];
  u64 output_values[3];
  u64 game_input_values[3];
  u64 self_pos_values[3];
  u64 correction_state;
  u64 effective_direction[3];
};
struct movement_trace_state { u64 next; struct movement_trace_row rows[32]; };
struct movement_invocation { void *previous; u32 active; u32 generation; };
struct movement_selection_invocation { struct movement_trace_row *row; void *output; u64 sequence; u64 call; u32 active; u32 generation; u32 thread; };
#define MT ((struct movement_trace_state*)S->movement_trace)
static void movement_copy3(u64 *out, void *p) {
  if (!out || !p) return;
  out[0] = init_float_bits(*(float*)p);
  out[1] = init_float_bits(*(float*)((u8*)p+4));
  out[2] = init_float_bits(*(float*)((u8*)p+8));
}
void configure_movement_trace(void *p) { S->movement_trace = p; }
u32 movement_trace_row_size(void) { return sizeof(struct movement_trace_row); }
u32 movement_trace_state_size(void) { return sizeof(struct movement_trace_state); }
static struct movement_trace_row *movement_begin(void *actor, void *input) {
  struct movement_trace_row *r; u64 n;
  if (!MT || !S->initialization_active_record || !g_ready || !g_injecting ||
      actor != g_player_logic ||
      ((struct init_record*)S->initialization_active_record)->h[1] != g_generation ||
      ((struct init_record*)S->initialization_active_record)->h[2] != GetCurrentThreadId()) return 0;
  n = ++MT->next; r = &MT->rows[(n-1) % 32];
  { u32 i; for (i=0;i<sizeof(*r)/sizeof(u64);i++) ((u64*)r)[i]=0; }
  r->sequence=n; r->generation=g_generation; r->thread=GetCurrentThreadId();
  r->initialization_sequence=((struct init_record*)S->initialization_active_record)->h[0];
  r->actor=(u64)actor; r->input_arg=(u64)input;
  r->input_values[0]=input?init_float_bits(*(float*)input):0;
  r->input_values[1]=input?init_float_bits(*(float*)((u8*)input+4)):0;
  r->input_values[2]=input?init_float_bits(*(float*)((u8*)input+8)):0;
  r->ba2e40_calls=1;
  return r;
}

// Ordinary native passthrough wrappers, not listener callbacks. This preserves
// visibility when invoked inside the existing C08B40 onLeave callback.
u64 movement_native_wrapper(void *actor,u32 id,void *target,void *alias,void *input,
    void *source,void *extra,u8 flag,float scale) {
  struct init_record *init=(struct init_record*)S->initialization_active_record;
  void *previous=0;u32 generation=g_generation;int scoped=0;u64 result;
  if(g_ready && g_injecting && MT && init && init->h[1]==g_generation &&
      init->h[2]==GetCurrentThreadId()) {
    previous=S->movement_scope;S->movement_scope=0;scoped=1;
    S->movement_scope=movement_begin(actor,input);
  }
  result=movement_original(actor,id,target,alias,input,source,extra,flag,scale);
  if(scoped && generation==g_generation)S->movement_scope=previous;
  return result;
}

void set_effective_input_policy(u32 enabled) {S->effective_input_enabled=enabled!=0;}
static float movement_bits_float(u64 bits){union{float f;u32 u;}v;v.u=(u32)bits;return v.f;}
static void *effective_movement_input(struct movement_trace_row *r,void *row,void *original,float buffer[4]) {
  struct init_record *init=(struct init_record*)S->initialization_active_record;u32 i;
  if(!r)return original;
  r->correction_state=0;movement_copy3(r->effective_direction,original);
  if(!S->effective_input_enabled)return original;
  if(!init || !g_ready || !g_injecting || init->h[0]!=r->initialization_sequence ||
     init->h[1]!=g_generation || init->h[2]!=GetCurrentThreadId() ||
     r->generation!=g_generation || r->thread!=GetCurrentThreadId() ||
     r->actor!=(u64)g_player_logic || !S->ordinary_direction_request) {
    r->correction_state=4;return original;
  }
  // Witnessed native mode3 consumes world-space input and handles its own
  // normalization; mode/row/predicate are never rewritten. Unknown modes
  // remain unchanged until their actual movement semantics are established.
  if(!row || read_u8(row,0x60)!=3 || read_u8(row,0x3a)!=1) {
    r->correction_state=2;return original;
  }
  for(i=0;i<3;i++) {
    if((init->requested_direction[i]&0x7f800000ULL)==0x7f800000ULL) {
      r->correction_state=3;return original;
    }
    buffer[i]=movement_bits_float(init->requested_direction[i]);
  }
  buffer[3]=0.0f;
  if(buffer[2]!=0.0f || (buffer[0]==0.0f && buffer[1]==0.0f)) {
    r->correction_state=3;return original;
  }
  r->correction_state=1;movement_copy3(r->effective_direction,buffer);return buffer;
}

u8 movement_select_native_wrapper(void *duration,void *out,void *position_out,void *row,
    void *self_pos,void *game_input,void *front,void *right,void *up,void *dir,
    u64 context,void *cached_pos,void *cached_rotation,void *offset,void *target_pos,
    void *target_front,void *target_right,void *target_up,float target_size,
    void *bone_position,void *debug_text) {
  struct movement_trace_row *r=(struct movement_trace_row*)S->movement_scope;
  u64 sequence=0,call=0;u32 generation=g_generation,thread=GetCurrentThreadId();u8 result;
  float effective_input[4];void *effective_dir=dir;
  if(!r || !g_ready || !g_injecting || r->generation!=generation || r->thread!=thread)r=0;
  if(r) {
    sequence=r->sequence;call=++r->be3bc0_calls;
    r->row=(u64)row;r->self_pos=(u64)self_pos;r->game_input=(u64)game_input;r->direction=(u64)dir;
    if(row) {
      r->row_60=read_u8(row,0x60);r->row_3a=read_u8(row,0x3a);r->row_6c=read_u8(row,0x6c);
      r->row_90=read_u32(row,0x90);r->row_94=read_u32(row,0x94);
      r->row_98=read_u32(row,0x98);r->row_9c=read_u32(row,0x9c);
    }
    movement_copy3(r->self_front,front);movement_copy3(r->self_right,right);movement_copy3(r->self_up,up);
    movement_copy3(r->direction_values,dir);movement_copy3(r->game_input_values,game_input);
    movement_copy3(r->self_pos_values,self_pos);
  }
  effective_dir=effective_movement_input(r,row,dir,effective_input);
  result=movement_select_original(duration,out,position_out,row,self_pos,game_input,front,right,up,effective_dir,
    context,cached_pos,cached_rotation,offset,target_pos,target_front,target_right,target_up,target_size,bone_position,debug_text);
  if(r && g_ready && g_injecting && g_generation==generation && r->generation==generation &&
      r->thread==thread && r->sequence==sequence && r->be3bc0_calls==call) {
    r->output_movement=(u64)out;movement_copy3(r->output_values,out);
  }
  return result;
}
u32 read_movement_trace(void *out) {
  u32 i,j; struct movement_trace_row *dst=out;
  if (!MT) return 0;
  for(i=0;i<32;i++) for(j=0;j<sizeof(struct movement_trace_row)/sizeof(u64);j++)
    ((u64*)&dst[i])[j]=((u64*)&MT->rows[i])[j];
  return 32;
}

static void reset_owned(void) {
  g_owned_evade = 0;
  S->owned_guard=0;S->owned_guard_release_attempted=0;S->guard_unexpected_step=0;
  g_owned_runtime = 0;
  S->owned_diag = 0;
  S->owned_diag_source = 0;
  S->owned_diag_step = 0;
}

static void reset_action_candidates(void) {
  u32 i;
  g_action_candidate_count = 0;
  g_selected_action_index = 0xffffffffU;
  for (i = 0; i != ACTION_CANDIDATE_CAPACITY; i++) {
    g_action_candidates[i].skill_id = 0;
    g_action_candidates[i].command_key = 0;
  }
}

static void reset_tokens(void) {
  u32 i;
  for (i = 0; i != MELEE_TOKEN_CAPACITY; i++) {
    g_melee_tokens[i].source = 0;
    g_melee_tokens[i].step = 0;
    g_melee_tokens[i].generation = 0;
    g_melee_tokens[i].source_epoch = 0;
  }
  for (i = 0; i != PROJECTILE_TOKEN_CAPACITY; i++) {
    g_projectile_tokens[i].projectile = 0;
    g_projectile_tokens[i].target_actor = 0;
    g_projectile_tokens[i].generation = 0;
    g_projectile_tokens[i].projectile_id = 0;
    g_projectile_tokens[i].state = 0;
    g_projectile_tokens[i].gate_seen = 0;
    g_projectile_tokens[i].natural_updates_at_claim = 0;
    g_projectile_tokens[i].pending = 0;
    g_projectile_tokens[i].pending_active_skill = 0;
    g_projectile_tokens[i].pending_step = 0;
    g_projectile_tokens[i].pending_runtime = 0;
    g_projectile_tokens[i].pending_generation = 0;
    g_projectile_tokens[i].pending_repeat_eligible = 0;
    g_projectile_tokens[i].pending_step239 = 0;
    g_projectile_tokens[i].pending_step240 = 0;
  }
  for (i = 0; i != MELEE_DIAG_CAPACITY; i++) {
    g_melee_diag[i].source = 0;
    g_melee_diag[i].step = 0;
    g_melee_diag[i].generation = 0;
    g_melee_diag[i].step_id = 0;
    g_melee_diag[i].step_type = 0;
    g_melee_diag[i].source_epoch = 0;
    g_melee_diag[i].calls = 0;
    g_melee_diag[i].blocked_active = 0;
    g_melee_diag[i].duplicate_suppressed = 0;
    g_melee_diag[i].requests = 0;
    g_melee_diag[i].installed = 0;
    g_melee_diag[i].last_result = 0;
    g_melee_diag[i].native_stops = 0;
    g_melee_diag[i].stop_confirmed = 0;
    g_melee_diag[i].stop_failed = 0;
    g_melee_diag[i].restart_attempts = 0;
    g_melee_diag[i].restart_installed = 0;
    g_melee_diag[i].restart_rejected = 0;
    g_melee_diag[i].epoch_after = 0;
    g_melee_diag[i].interaction = 0;
    g_melee_diag[i].interaction_class = 0;
    g_melee_diag[i].out_accepted = 0;
    g_melee_diag[i].angle_probe_seen = 0;
    g_melee_diag[i].angle_result_al = 0;
    g_melee_diag[i].angle_source_match = 0;
    g_melee_diag[i].angle_defender_match = 0;
    g_melee_diag[i].angle_threshold_bits = 0;
    g_melee_diag[i].angle_source_ptr = 0;
    g_melee_diag[i].angle_defender_ptr = 0;
    g_melee_diag[i].just_consumer_calls = 0;
    g_melee_diag[i].just_consumer_matched = 0;
    g_melee_diag[i].just_consumer_completed = 0;
    g_melee_diag[i].just_consumer_result_type = 0;
    g_melee_diag[i].just_consumer_descriptor = 0;
    g_melee_diag[i].just_consumer_step_id = 0;
    g_melee_diag[i].just_consumer_step_type = 0;
    g_melee_diag[i].just_resolution_seen = 0;
    g_melee_diag[i].just_resolution_descriptor = 0;
    g_melee_diag[i].just_resolution_step_id = 0;
    g_melee_diag[i].just_resolution_step_type = 0;
  }
  for (i = 0; i != FILTER_THREAD_SLOTS; i++) {
    g_builder_slots[i].thread_id = 0;
    g_builder_slots[i].generation = 0;
    g_builder_slots[i].projectile = 0;
    g_builder_slots[i].data = 0;
    g_builder_slots[i].count = 0;
    g_builder_slots[i].projectile_id = 0;
    g_builder_slots[i].sequence = 0;
    g_builder_slots[i].secondary_count = 0;
    g_actor_resolve_slots[i].thread_id = 0;
    g_actor_resolve_slots[i].active = 0;
    g_actor_resolve_slots[i].projectile = 0;
    g_actor_resolve_slots[i].record = 0;
    g_actor_resolve_slots[i].projectile_id = 0;
    g_actor_resolve_slots[i].sequence = 0;
    S->gate_slots[i].thread_id = 0;
    S->gate_slots[i].active = 0;
    S->gate_slots[i].projectile = 0;
    S->gate_slots[i].target_logic = 0;
    S->gate_slots[i].projectile_id = 0;
    S->gate_slots[i].gate_seen = 0;
    S->gate_slots[i].generation = 0;
    S->melee_pair_slots[i].thread_id = 0;
    S->melee_pair_slots[i].active = 0;
    S->melee_pair_slots[i].target_group = 0;
    S->melee_pair_slots[i].generation = 0;
    S->melee_pair_slots[i].attempted = 0;
    S->melee_pair_slots[i].installed = 0;
    S->melee_call_contexts[i].active = 0;
  }
  g_melee_cursor = 0;
  S->melee_token_count = 0;
  g_projectile_cursor = 0;
  g_melee_diag_cursor = 0;
  S->ranged_request_diag.attempt_sequence = 0;
  S->ranged_request_diag.owned_snapshot_valid = 0;
  S->ranged_request_diag.native_selector_deferred = 0;
  S->ranged_request_diag.native_request_submitted = 0;
  S->deferred_projectile = 0;
  S->ranged_wait_evade = 0;
  S->ranged_wait_runtime = 0;
  S->melee_pending_cursor = 0;
  for (i = 0; i != MELEE_DIAG_CAPACITY; i++) {
    S->melee_pending[i].active = 0;
    S->melee_pending[i].source = 0;
    S->melee_pending[i].source_step = 0;
    S->melee_pending[i].player_logic = 0;
    S->melee_pending[i].active_skill = 0;
    S->melee_pending[i].active_step = 0;
    S->melee_pending[i].player_runtime = 0;
    S->melee_pending[i].generation = 0;
    S->melee_pending[i].source_epoch = 0;
  }
}

static int finite_input_float(float value);
static void health_note_source(u32 kind,void *source,u32 id,u32 result);
static void health_sample_player(void *skill);

static int capture_repeat_phase(struct repeat_phase *phase) {
  void *manager;
  void *active;
  void *step;
  float elapsed;
  float threshold;
  u32 runtime;
  if (!phase) return 0;
  phase->active_skill = 0;
  phase->step = 0;
  phase->runtime = 0;
  phase->state = 0;
  phase->repeat_eligible = 0;
  phase->step239 = 0;
  phase->step240 = 0;
  if (!g_player_logic || !g_logic_manager_host || !g_active_resolver) return 0;
  runtime = read_u32(g_player_logic, LOGIC_RUNTIME_ID);
  if (runtime == 0) return 0;
  manager = ((logic_manager_host_t)g_logic_manager_host)();
  if (!manager) return 0;
  active = ((active_resolver_t)g_active_resolver)(manager, runtime);
  if (!active || read_u8(active, SKILL_ACTIVE) != 1 ||
      read_pointer(active, 0x68) != g_player_logic ||
      read_u32(g_player_logic, LOGIC_RUNTIME_ID) != runtime) return 0;
  step = read_pointer(active, SKILL_CURRENT_STEP);
  if (!step) return 0;
  elapsed = read_f32(active, 0xb0);
  threshold = read_f32(step, 0x23c);
  if (!finite_input_float(elapsed) || !finite_input_float(threshold)) return 0;
  phase->active_skill = active;
  phase->step = step;
  phase->runtime = runtime;
  phase->state = read_u8(active, SKILL_ACTIVE);
  phase->step239 = read_u8(step, 0x239) != 0;
  phase->step240 = read_u8(step, 0x240) != 0;
  phase->repeat_eligible = phase->step239 && elapsed >= threshold;
  return 1;
}

static void invalidate_melee_pending(struct melee_pending *pending) {
  if (!pending || !pending->active) return;
  pending->active = 0;
  S->pending_invalidated++;
}

static void clear_melee_pending(struct melee_pending *pending) {
  if (!pending) return;
  pending->active = 0;
}

static void sweep_melee_pending(void) {
  u32 i;
  u32 runtime = g_player_logic == 0 ? 0 : read_u32(g_player_logic, LOGIC_RUNTIME_ID);
  for (i = 0; i != MELEE_DIAG_CAPACITY; i++) {
    struct melee_pending *pending = &S->melee_pending[i];
    if (!pending->active) continue;
    if (pending->generation != g_generation || pending->player_logic != g_player_logic ||
        pending->player_runtime == 0 || runtime == 0 || pending->player_runtime != runtime) {
      invalidate_melee_pending(pending);
    }
  }
}

static struct melee_pending *find_melee_pending(void *source, void *source_step,
    u32 source_epoch) {
  u32 i;
  if (!source || !source_step) return 0;
  for (i = 0; i != MELEE_DIAG_CAPACITY; i++) {
    struct melee_pending *pending = &S->melee_pending[i];
    if (pending->active && pending->generation == g_generation &&
        pending->player_logic == g_player_logic && pending->source == source &&
        pending->source_step == source_step && pending->source_epoch == source_epoch) {
      return pending;
    }
  }
  return 0;
}

static struct melee_pending *find_melee_pending_source(void *source, void *source_step) {
  u32 i;
  if (!source || !source_step) return 0;
  for (i = 0; i != MELEE_DIAG_CAPACITY; i++) {
    struct melee_pending *pending = &S->melee_pending[i];
    if (pending->active && pending->generation == g_generation &&
        pending->player_logic == g_player_logic && pending->source == source &&
        pending->source_step == source_step) return pending;
  }
  return 0;
}

static int melee_pending_same_phase(struct melee_pending *pending,
    struct repeat_phase *phase) {
  if (!pending || !pending->active || !phase) return 0;
  return phase->runtime == pending->player_runtime &&
    phase->active_skill == pending->active_skill && phase->step == pending->active_step &&
    phase->repeat_eligible == pending->repeat_eligible &&
    phase->step239 == pending->step239 && phase->step240 == pending->step240;
}

static int repeat_phase_still_current(struct repeat_phase *before) {
  struct repeat_phase after;
  return before && capture_repeat_phase(&after) &&
    before->runtime == after.runtime && before->active_skill == after.active_skill &&
    before->step == after.step && before->repeat_eligible == after.repeat_eligible &&
    before->step239 == after.step239 && before->step240 == after.step240;
}

static struct melee_pending *set_melee_pending(void *source, void *source_step,
    u32 source_epoch, struct repeat_phase *phase) {
  struct melee_pending *pending;
  u32 i;
  if (!phase || !phase->active_skill || !phase->step || phase->runtime == 0 ||
      source == 0 || source_step == 0 || g_generation == 0 ||
      !repeat_phase_still_current(phase)) return 0;
  pending = find_melee_pending(source, source_step, source_epoch);
  if (!pending) {
    for (i = 0; i != MELEE_DIAG_CAPACITY; i++) {
      pending = &S->melee_pending[(S->melee_pending_cursor + i) % MELEE_DIAG_CAPACITY];
      if (!pending->active) {
        S->melee_pending_cursor = (S->melee_pending_cursor + i + 1) % MELEE_DIAG_CAPACITY;
        break;
      }
      pending = 0;
    }
  }
  if (!pending) return 0;
  pending->active = 1;
  pending->generation = g_generation;
  pending->source_epoch = source_epoch;
  pending->player_runtime = phase->runtime;
  pending->source = source;
  pending->source_step = source_step;
  pending->player_logic = g_player_logic;
  pending->active_skill = phase->active_skill;
  pending->active_step = phase->step;
  pending->active_state = phase->state;
  pending->repeat_eligible = phase->repeat_eligible;
  pending->step239 = phase->step239;
  pending->step240 = phase->step240;
  S->pending_created++;
  return pending;
}

static int set_projectile_pending(struct projectile_token *token,
    struct repeat_phase *phase) {
  if (!token || !phase || !phase->active_skill || !phase->step ||
      phase->runtime == 0 || g_generation == 0 ||
      !repeat_phase_still_current(phase)) return 0;
  token->pending = 1;
  token->pending_active_skill = phase->active_skill;
  token->pending_step = phase->step;
  token->pending_runtime = phase->runtime;
  token->pending_generation = g_generation;
  token->pending_repeat_eligible = phase->repeat_eligible;
  token->pending_step239 = phase->step239;
  token->pending_step240 = phase->step240;
  token->state = PROJECTILE_PENDING;
  S->pending_created++;
  return 1;
}

static int projectile_pending_same_phase(struct projectile_token *token,
    struct repeat_phase *phase) {
  if (!token || !token->pending || !phase || token->pending_generation != g_generation ||
      token->pending_runtime != phase->runtime || token->pending_active_skill != phase->active_skill ||
      token->pending_step != phase->step) return 0;
  return token->pending_repeat_eligible == phase->repeat_eligible &&
    token->pending_step239 == phase->step239 && token->pending_step240 == phase->step240;
}

static void clear_projectile_pending(struct projectile_token *token, int invalidated) {
  if (!token || !token->pending) return;
  token->pending = 0;
  token->pending_active_skill = 0;
  token->pending_step = 0;
  token->pending_runtime = 0;
  token->pending_generation = 0;
  token->pending_repeat_eligible = 0;
  token->pending_step239 = 0;
  token->pending_step240 = 0;
  if (invalidated) S->pending_invalidated++;
}

static struct melee_diag *get_melee_diag(void *source, void *step, u32 source_epoch) {
  struct melee_diag *diag;
  u32 i;
  if (source == 0 || step == 0) return 0;
  for (i = 0; i != MELEE_DIAG_CAPACITY; i++) {
    if (g_melee_diag[i].generation == g_generation &&
        g_melee_diag[i].source == source && g_melee_diag[i].step == step &&
        g_melee_diag[i].source_epoch == source_epoch) {
      return &g_melee_diag[i];
    }
  }
  diag = &g_melee_diag[g_melee_diag_cursor];
  diag->source = source;
  diag->step = step;
  diag->generation = g_generation;
  diag->step_id = read_u32(step, STEP_ID);
  diag->step_type = read_u32(step, STEP_TYPE);
  diag->source_epoch = source_epoch;
  diag->calls = 0;
  diag->blocked_active = 0;
  diag->duplicate_suppressed = 0;
  diag->requests = 0;
  diag->installed = 0;
  diag->last_result = 0;
  diag->native_stops = 0;
  diag->stop_confirmed = 0;
  diag->stop_failed = 0;
  diag->restart_attempts = 0;
  diag->restart_installed = 0;
  diag->restart_rejected = 0;
  diag->epoch_after = source_epoch;
  diag->interaction = 0;
  diag->interaction_class = 0;
  diag->out_accepted = 0;
  diag->angle_probe_seen = 0;
  diag->angle_result_al = 0;
  diag->angle_source_match = 0;
  diag->angle_defender_match = 0;
  diag->angle_threshold_bits = 0;
  diag->angle_source_ptr = 0;
  diag->angle_defender_ptr = 0;
  diag->just_consumer_calls = 0;
  diag->just_consumer_matched = 0;
  diag->just_consumer_completed = 0;
  diag->just_consumer_result_type = 0;
  diag->just_consumer_descriptor = 0;
  diag->just_consumer_step_id = 0;
  diag->just_consumer_step_type = 0;
  diag->just_resolution_seen = 0;
  diag->just_resolution_descriptor = 0;
  diag->just_resolution_step_id = 0;
  diag->just_resolution_step_type = 0;
  diag->selector_returned = 0;
  diag->selector_fallback_used = 0;
  diag->request_returned_nonnull = 0;
  diag->request_returned_null = 0;
  diag->runtime_changed = 0;
  diag->pending_state = 0;
  diag->forced_bfd340_issued = 0;
  diag->active_state = 0;
  diag->current_step_established = 0;
  diag->old_owned_active = 0;
  diag->natural_bfd340_seen = 0;
  diag->token_expirations = 0;
  diag->accepted_true = 0;
  diag->accepted_false = 0;
  diag->source_gate_calls = 0;
  diag->source_gate_true = 0;
  diag->source_gate_false = 0;
  diag->available_just_action = read_u8(step, 0x30);
  diag->attempt_sequence = 0;
  diag->native_selector_deferred = 0;
  diag->native_request_submitted = 0;
  g_melee_diag_cursor = (g_melee_diag_cursor + 1) % MELEE_DIAG_CAPACITY;
  return diag;
}

static int has_owned_active(void) {
  if (g_owned_evade == 0 || g_player_logic == 0) return 0;
  if (read_u32(g_player_logic, LOGIC_RUNTIME_ID) != g_owned_runtime ||
      read_u8(g_owned_evade, SKILL_ACTIVE) != 1) {
    reset_owned();
    return 0;
  }
  return 1;
}

static struct melee_token *find_melee_token(void *source) {
  u32 i;
  if (source == 0) return 0;
  for (i = 0; i != S->melee_token_count; i++) {
    if (g_melee_tokens[i].generation == g_generation &&
        g_melee_tokens[i].source == source) {
      return &g_melee_tokens[i];
    }
  }
  return 0;
}

static void expire_melee_token(struct melee_token *token) {
  u32 i;
  if (token == 0 || token->step == 0) return;
  for (i = 0; i != MELEE_DIAG_CAPACITY; i++) {
    struct melee_diag *diag = &g_melee_diag[i];
    if (diag->generation == token->generation &&
        diag->source == token->source && diag->step == token->step &&
        diag->source_epoch == token->source_epoch) {
      diag->token_expirations++;
      break;
    }
  }
  token->step = 0;
}

// Only dereference the live source supplied by BFD340. Cached sources are
// compared by address, never polled or dereferenced from the binding timer.
static void observe_melee_source_lifecycle(void *source) {
  struct melee_token *token;
  u32 i;
  if (!g_ready || g_injecting || source == 0) return;
  token = find_melee_token(source);
  if (token != 0 && token->step != 0 &&
      (read_pointer(source, SKILL_CURRENT_STEP) != token->step ||
       read_u8(source, SKILL_ACTIVE) == 3)) {
    expire_melee_token(token);
  }
  for (i = 0; i != MELEE_DIAG_CAPACITY; i++) {
    struct melee_pending *pending = &S->melee_pending[i];
    if (!pending->active || pending->source != source ||
        pending->generation != g_generation) continue;
    if (read_pointer(source, SKILL_CURRENT_STEP) != pending->source_step ||
        read_u32(source, SKILL_RESULT_EPOCH) != pending->source_epoch ||
        read_u32(g_player_logic, LOGIC_RUNTIME_ID) != pending->player_runtime) {
      invalidate_melee_pending(pending);
    }
  }
}

static int has_melee_step(void *source, void *step, u32 source_epoch) {
  struct melee_token *token;
  if (source == 0 || step == 0) return 1;
  token = find_melee_token(source);
  return token != 0 && token->step == step;
}

static void remember_melee_step(void *source, void *step, u32 source_epoch) {
  struct melee_token *token;
  if (source == 0 || step == 0) return;
  token = find_melee_token(source);
  if (token == 0) {
    token = &g_melee_tokens[g_melee_cursor];
    g_melee_cursor = (g_melee_cursor + 1) % MELEE_TOKEN_CAPACITY;
    if (S->melee_token_count < MELEE_TOKEN_CAPACITY) S->melee_token_count++;
  } else if (token->step != step) {
    // BFE9E0 itself also proves a changed current Step, even when the
    // transition happened between the observed natural update calls.
    expire_melee_token(token);
  }
  token->source = source;
  token->step = step;
  token->generation = g_generation;
  token->source_epoch = source_epoch;
}

static struct projectile_token *find_projectile_target(
    void *projectile, void *target_actor, u32 projectile_id) {
  u32 i;
  if (projectile == 0 || target_actor == 0) return 0;
  for (i = 0; i != PROJECTILE_TOKEN_CAPACITY; i++) {
    if (g_projectile_tokens[i].generation == g_generation &&
        g_projectile_tokens[i].projectile == projectile &&
        g_projectile_tokens[i].target_actor == target_actor &&
        g_projectile_tokens[i].projectile_id == projectile_id) {
      return &g_projectile_tokens[i];
    }
  }
  return 0;
}

static struct projectile_token *create_projectile_target(
    void *projectile, void *target_actor, u32 projectile_id) {
  struct projectile_token *token;
  if (projectile == 0 || target_actor == 0) return 0;
  token = &g_projectile_tokens[g_projectile_cursor];
  token->projectile = projectile;
  token->target_actor = target_actor;
  token->generation = g_generation;
  token->projectile_id = projectile_id;
  token->state = 0;
  token->gate_seen = 0;
  token->natural_updates_at_claim = 0;
  g_projectile_cursor = (g_projectile_cursor + 1) % PROJECTILE_TOKEN_CAPACITY;
  return token;
}


// Input adaptation only. The original movement builder normalizes this
// vector; the original BFE9E0/BEF780 still decides every Perfect result.
typedef float *(*actor_position_t)(void *, void *);
static int finite_input_float(float value) {
  return (init_float_bits(value)&0x7f800000U)!=0x7f800000U;
}
static int native_actor_position(void *actor,float out[3]) {
  void *vtable; actor_position_t get_position; float buffer[4]={0};float *value;
  if(!actor)return 0;
  vtable=read_pointer(actor,0);if(!vtable)return 0;
  get_position=(actor_position_t)read_pointer(vtable,0x48);if(!get_position)return 0;
  value=get_position(actor,buffer);if(!value)return 0;
  if(!finite_input_float(value[0])||!finite_input_float(value[1])||!finite_input_float(value[2]))return 0;
  out[0]=value[0];out[1]=value[1];out[2]=value[2];return 1;
}
static int prepare_evade_input(void *source_actor,float out[4]) {
  float player[3],source[3];u32 i;
  for(i=0;i<4;i++)out[i]=g_direction[i];
  if(!S->source_direction_enabled)return 1;
  if(!g_player_logic || !source_actor || source_actor==g_player_logic ||
    !native_actor_position(g_player_logic,player) || !native_actor_position(source_actor,source))return 0;
  out[0]=player[0]-source[0];out[1]=player[1]-source[1];out[2]=0.0f;out[3]=0.0f;
  // Coincident horizontal positions retain native neutral-input handling;
  // do not invent a fixed world-axis direction or vertical ground dodge.
  return finite_input_float(out[0])&&finite_input_float(out[1]);
}
void set_source_direction_policy(u32 enabled) {S->source_direction_enabled=enabled!=0;}
void read_source_direction_stats(u64 *out) {
  out[0]=S->source_direction_enabled;out[1]=S->source_direction_requests;out[2]=S->source_direction_unavailable;out[3]=S->source_direction_selector_queries;
}

static int is_initial_guard_parry(void *step,u32 skill_id) {
  return step && step==S->guard_captured_step && read_u8(step,STEP_TYPE)==2 &&
    S->guard_capture_count==1 && !S->guard_capture_conflict &&
    S->guard_expected_row && read_u32(S->guard_expected_row,0x10)==skill_id &&
    S->guard_request_generation==g_generation &&
    S->guard_request_thread==GetCurrentThreadId();
}


static int try_evade_candidate(u32 index, struct melee_diag *diag) {
  struct action_candidate *candidate;
  void *command_manager;
  void *command_node;
  void *skill_logic;
  u64 command_key;
  u32 runtime_before;
  u32 runtime_after;
  int selector_ok;
  int request_active;
  int current_step_established;
  float request_direction[4];
  void *request_source,*ordinary_row=0;
  u32 previous_direction_request=S->ordinary_direction_request;

  u32 input_id = S->guard_request_active ? 26 : EVADE_INPUT_ID;
  if (!S->guard_request_active && index >= g_action_candidate_count) return 0;
  candidate = S->guard_request_active ? &S->guard_candidate : &g_action_candidates[index];
  if (candidate->skill_id == 0 || candidate->command_key == 0) return 0;
  command_key = candidate->command_key;

  request_source = diag && diag->source ? read_pointer(diag->source,0x68) : S->request_source_actor;
  if(S->guard_request_active) {
    request_direction[0]=0;request_direction[1]=0;request_direction[2]=0;request_direction[3]=0;
  } else if(!prepare_evade_input(request_source,request_direction)) {
    S->source_direction_unavailable++;
    return 0; // No request and no consumed source token when context is absent.
  }
  // D2BDD0's fifth flag skips only the physical input-vector angle gate
  // in D2AAD0. A valid automatic direction is supplied by this request;
  // every other native command eligibility check still runs.
  u32 selector_ignore_input_direction = !S->guard_request_active && S->source_direction_enabled &&
    (request_direction[0] != 0.0f || request_direction[1] != 0.0f);

  // Scene-local IDs identify candidate families only. The native selector
  // must supply the CURRENT command; a cached key is not permission to act.
  command_manager = g_player_actor == 0
    ? 0
    : read_pointer(g_player_actor, ACTOR_COMMAND_MANAGER);
  if (command_manager && g_select_command_node && selector_ignore_input_direction)
    S->source_direction_selector_queries++;
  command_node = (command_manager == 0 || g_select_command_node == 0)
    ? 0
    : g_select_command_node(
        command_manager, input_id, candidate->skill_id, 0.0f, selector_ignore_input_direction
      );
  selector_ok = 0;
  if (command_node != 0 &&
      read_u32(command_node, COMMAND_NODE_INPUT_ID) == input_id) {
    u64 current_key = read_u64(command_node, COMMAND_NODE_FNAME);
    if (current_key != 0) {
      command_key = current_key;
      selector_ok = 1;
    }
  }
  if (selector_ok) {
    S->selector_returned++;
    if (diag != 0) diag->selector_returned++;
  } else {
    return 0; // No native request has been made; another family may qualify.
  }

  if(!S->guard_request_active) {
    ordinary_row=current_action_row(candidate->skill_id);
    if(!action_row_qualifies(ordinary_row,EVADE_INPUT_ID))return 0;
  }
  if(S->source_direction_enabled && !S->guard_request_active)S->source_direction_requests++;
  runtime_before = read_u32(g_player_logic, LOGIC_RUNTIME_ID);
  S->attempts++;
  struct init_record *init_record = init_begin(candidate->skill_id, command_key, diag);
  if(init_record) {
    init_record->requested_direction[0]=init_float_bits(request_direction[0]);
    init_record->requested_direction[1]=init_float_bits(request_direction[1]);
    init_record->requested_direction[2]=init_float_bits(request_direction[2]);
    init_record->request_source=(u64)request_source;
  }
  void *previous_init = S->initialization_active_record;
  S->initialization_active_record = init_record;
  S->ordinary_direction_request=ordinary_row &&
    finite_input_float(read_f32(ordinary_row,0x118)) && read_f32(ordinary_row,0x118)>0.0f;
  if(S->guard_request_active) {
    S->guard_request_nonce++;S->guard_request_thread=GetCurrentThreadId();
    S->guard_request_generation=g_generation;S->guard_capture_count=0;
    S->guard_capture_conflict=0;S->guard_captured_step=0;
  }
  g_injecting = 1;
  if(S->action_trace_before)
    ((void(*)(u32,u64,float*))S->action_trace_before)(candidate->skill_id,command_key,request_direction);
  // BA23C0 argument six controls BB4030's pending-command write on refusal.
  // A null synchronous request must not leave a late, uncorrelated Evade.
  // Argument eight is the native request-local BlockSkill override, also
  // consumed by NewSkillLogic/BF5000 during activation. It creates no queue
  // and does not alter ActorState, persistent rows or native Just results.
  skill_logic = g_use_skill(
    g_player_logic, candidate->skill_id, g_location, request_direction,
    0, 0, command_key, 1, 0, 0, 0, 0
  );
  init_capture(init_record, 1, skill_logic);
  if(S->action_trace_after)((void(*)(void*))S->action_trace_after)(skill_logic);
  if (skill_logic != 0) {
    S->request_returned_nonnull++;
    if (diag != 0) diag->request_returned_nonnull++;
  } else {
    S->request_returned_null++;
    if (diag != 0) diag->request_returned_null++;
    else S->ranged_request_diag.request_returned_null++;
  }
  if (skill_logic != 0 && read_u8(skill_logic, SKILL_ACTIVE) == 0 &&
      read_u32(skill_logic, SKILL_DELAYED_FIRST_STEP) != 0) {
    S->pending_state++;
    S->forced_bfd340_issued++;
    if (diag != 0) {
      diag->pending_state++;
      diag->forced_bfd340_issued++;
    }
    if (init_record != 0) {init_record->h[9]++;init_record->h[13]=++IT->event;}
    g_update_skill(skill_logic, 1.0f / 60.0f);
  }
  init_capture(init_record, 2, skill_logic);
  S->initialization_active_record = previous_init;
  S->ordinary_direction_request=previous_direction_request;
  g_injecting = 0;

  runtime_after = read_u32(g_player_logic, LOGIC_RUNTIME_ID);
  if (runtime_before != runtime_after && runtime_after != 0) {
    S->runtime_changed++;
    if (diag != 0) diag->runtime_changed++;
  }
  request_active = skill_logic != 0 && read_u8(skill_logic, SKILL_ACTIVE) == 1;
  current_step_established =
    skill_logic != 0 && read_pointer(skill_logic, SKILL_CURRENT_STEP) != 0;
  if (request_active) {
    S->active_state++;
    if (diag != 0) diag->active_state++;
  }
  if (current_step_established) {
    S->current_step_established++;
    if (diag != 0) diag->current_step_established++;
  }
  if (skill_logic != 0 && runtime_before != runtime_after && runtime_after != 0 &&
      request_active &&
      read_u32(skill_logic, SKILL_DELAYED_COUNT) == 0 &&
      current_step_established) {
    g_owned_evade = skill_logic;
    S->owned_guard=S->guard_request_active;
    S->owned_guard_release_attempted=0;
    S->guard_unexpected_step=S->owned_guard &&
      !is_initial_guard_parry(read_pointer(skill_logic,SKILL_CURRENT_STEP),candidate->skill_id);
    g_owned_runtime = runtime_after;
    S->owned_diag = diag;
    S->owned_diag_source = diag == 0 ? 0 : diag->source;
    S->owned_diag_step = diag == 0 ? 0 : diag->step;
    if(!S->guard_request_active)g_selected_action_index = index;
    if(S->guard_unexpected_step){S->guard_stats[15]++;S->rejected++;return 2;}
    S->installed++;
    return 1;
  }

  S->rejected++;
  return 2; // A real request was submitted and failed; do not fan out retries.
}


// Build24463856 Sword Blink/Repulse: separate native actions, never Evade leases.
typedef u64 (*special_clock_t)(void);
typedef void *(*special_manager_t)(void);
typedef void *(*special_skill_lookup_t)(void*,void*,u32);
typedef void *(*special_step_lookup_t)(void*,void*,u64*);
typedef u8 (*special_query_t)(void*,u64*,void*,u8,void*,u32,float,float,u32,void*);
typedef void (*special_free_t)(void*);
struct special_target_array { void **data; u32 count; u32 capacity; };

static void special_clear_latch(void) {
  S->special_latched_skill_id=0;
  S->special_latched_key=0;
  S->special_latched_target=0;
}
static void special_clear_ownership(void) {
  S->special_tracked_runtime=0;
  S->special_tracked_skill=0;
  S->special_active_snapshot=0;
  special_clear_latch();
}
static void special_reset_binding(void) {
  special_clear_ownership();
  S->special_generation=g_generation;
  S->special_enabled=S->special_allowed;
  S->special_poll_clock_valid=0;
  S->special_last_poll=0;
  S->special_last_skill_id=0;
  S->special_tracked_key=0;
  S->special_tracked_target=0;
  S->special_initial_step=0;
  S->special_latest_step=0;
}
void configure_special_response(void *manager,void *skill_lookup,void *step_lookup,
    void *query,void *free_fn,void *clock_fn,u32 enabled) {
  S->special_data_manager=manager;
  S->special_skill_lookup=skill_lookup;
  S->special_step_lookup=step_lookup;
  S->special_target_query=query;
  S->special_free=free_fn;
  S->special_clock=clock_fn;
  S->special_allowed=enabled!=0;
  special_reset_binding();
}
static int special_binding_matches(void *actor,void *logic,u32 generation) {
  return g_ready && S->special_enabled && generation==g_generation &&
    generation==S->special_generation && actor==g_player_actor && logic==g_player_logic;
}
// Only called from the game's callbacks. Resolve current runtime identity before
// dereferencing the saved object; the RPC status reader never follows this pointer.
static int special_active(void) {
  void *manager,*current,*step;
  S->special_active_snapshot=0;
  if(!g_ready || !S->special_enabled || S->special_generation!=g_generation ||
     !S->special_tracked_runtime || !S->special_tracked_skill || !g_player_logic ||
     !g_logic_manager_host || !g_active_resolver ||
     read_u32(g_player_logic,LOGIC_RUNTIME_ID)!=S->special_tracked_runtime)return 0;
  manager=((logic_manager_host_t)g_logic_manager_host)();
  if(!manager)return 0;
  current=((active_resolver_t)g_active_resolver)(manager,(u32)S->special_tracked_runtime);
  if(current!=S->special_tracked_skill || read_pointer(current,0x68)!=g_player_logic ||
     read_u8(current,SKILL_ACTIVE)!=1)return 0;
  S->special_active_snapshot=1;
  step=read_pointer(current,SKILL_CURRENT_STEP);
  if(step)S->special_latest_step=read_u32(step,STEP_ID);
  return 1;
}
void read_special_response_stats(u64 *out) {
  out[0]=S->special_polls;out[1]=S->special_selector_queries;
  out[2]=S->special_qualified;out[3]=S->special_requests;
  out[4]=S->special_returned_null;out[5]=S->special_blue;out[6]=S->special_purple;
  out[7]=S->special_active_snapshot;out[8]=S->special_tracked_runtime;
  out[9]=S->special_last_skill_id;out[10]=S->special_tracked_key;
  out[11]=(u64)S->special_tracked_target;out[12]=S->special_initial_step;
  out[13]=S->special_latest_step;out[14]=S->special_enabled && g_ready;
  out[15]=S->special_generation;out[16]=S->special_max_poll_ms;
  out[17]=S->special_total_poll_ms;out[18]=S->special_binding_changed;
}
// 0: unavailable (may check another family); 1: this window already attempted;
// 2: submitted, including NULL; 3: context changed, stop this poll.
static int special_try(u32 skill_id,int purple) {
  void *actor=g_player_actor,*logic=g_player_logic;
  u32 generation=g_generation,i,prior_injecting;
  void *command_manager,*node,*manager,*table,*skill,*step,*target_logic=0,*result;
  u64 key=0,filter;
  float player[3],target[3],location[4],direction[4];
  struct special_target_array targets={0};
  special_free_t free_targets=(special_free_t)S->special_free;
  int outcome=0;
  u8 queried;
  if(!actor || !logic || !special_binding_matches(actor,logic,generation) ||
     !S->special_data_manager || !S->special_skill_lookup || !S->special_step_lookup ||
     !S->special_target_query || !free_targets || !g_select_command_node || !g_use_skill)return 3;
  command_manager=read_pointer(actor,ACTOR_COMMAND_MANAGER);
  if(!command_manager || !read_pointer(command_manager,0x70))return 0;
  // The fifth native flag skips only physical input-vector/angle testing. The
  // current command's target/Chance/NoResult/acquisition gates still execute.
  S->special_selector_queries++;
  node=g_select_command_node(command_manager,EVADE_INPUT_ID,skill_id,0.0f,1);
  if(!special_binding_matches(actor,logic,generation)){outcome=3;goto done;}
  if(!node || read_u32(node,COMMAND_NODE_INPUT_ID)!=EVADE_INPUT_ID ||
     !(key=read_u64(node,COMMAND_NODE_FNAME)))goto done;
  manager=((special_manager_t)S->special_data_manager)();
  table=manager?read_pointer(manager,0x20):0;
  skill=table?((special_skill_lookup_t)S->special_skill_lookup)(table,0,skill_id):0;
  if(!special_binding_matches(actor,logic,generation)){outcome=3;goto done;}
  if(!skill || read_u8(skill,8)!=1 || read_u32(skill,0x10)!=skill_id ||
     !read_u8(skill,0x88))goto done;
  // A valid selector need not materialize the first Step yet. UseSkill owns
  // that lazy initialization, just as it does for a fresh manual activation.
  filter=read_u64(skill,0xb4);
  if(read_pointer(actor,0x630) && read_u64(skill,0xbc))filter=read_u64(skill,0xbc);
  if(!filter)goto done;
  if(!special_binding_matches(actor,logic,generation)){outcome=3;goto done;}
  queried=((special_query_t)S->special_target_query)(logic,&filter,&targets,1,0,
    read_u8(skill,0x75),0.0f,0.3f,0xffff0000U,0);
  if(!special_binding_matches(actor,logic,generation)){outcome=3;goto done;}
  // These exact native filters select one target. Do not manufacture or merge
  // target lists, and retain the allocator ownership until UseSkill returns.
  if(!queried || !targets.data || targets.count!=1 || targets.capacity<targets.count)goto done;
  target_logic=targets.data[0];
  if(!target_logic || target_logic==logic || !native_actor_position(logic,player) ||
     !native_actor_position(target_logic,target))goto done;
  for(i=0;i<3;i++)location[i]=player[i];location[3]=0;
  direction[0]=target[0]-player[0];direction[1]=target[1]-player[1];
  direction[2]=0;direction[3]=0;
  if(!finite_input_float(direction[0]) || !finite_input_float(direction[1]) ||
     (direction[0]==0.0f && direction[1]==0.0f))goto done;
  if(!special_binding_matches(actor,logic,generation)){outcome=3;goto done;}
  if(S->special_latched_skill_id==skill_id && S->special_latched_key==key &&
     S->special_latched_target==target_logic){outcome=1;goto done;}
  S->special_latched_skill_id=skill_id;S->special_latched_key=key;
  S->special_latched_target=target_logic;S->special_qualified++;
  S->special_last_skill_id=skill_id;S->special_tracked_key=key;
  S->special_tracked_target=target_logic;S->special_initial_step=0;S->special_latest_step=0;
  S->special_requests++;if(purple)S->special_purple++;else S->special_blue++;
  prior_injecting=g_injecting;g_injecting=1;
  if(S->action_trace_before)
    ((void(*)(u32,u64,float*))S->action_trace_before)(skill_id,key,direction);
  // Native copies the TArray at argument nine. Queue creation stays disabled;
  // request-local activation permission is the same established auto-only flag.
  result=g_use_skill(logic,skill_id,location,direction,0,0,key,1,&targets,0,0,0);
  if(S->action_trace_after)((void(*)(void*))S->action_trace_after)(result);
  g_injecting=prior_injecting;
  outcome=2;
  if(!result)S->special_returned_null++;
  if(!special_binding_matches(actor,logic,generation)){outcome=3;goto done;}
  if(result && read_pointer(result,0x68)==logic && read_pointer(result,0x58) &&
     read_u32(read_pointer(result,0x58),0x10)==skill_id) {
    S->special_tracked_skill=result;
    S->special_tracked_runtime=read_u32(logic,LOGIC_RUNTIME_ID);
    step=read_pointer(result,SKILL_CURRENT_STEP);
    S->special_initial_step=step?read_u32(step,STEP_ID):0;
    S->special_latest_step=S->special_initial_step;
    S->special_active_snapshot=read_u8(result,SKILL_ACTIVE)==1;
  }
done:
  if(targets.data)free_targets(targets.data);
  if(outcome==3)S->special_binding_changed++;
  if(outcome==0 && S->special_latched_skill_id==skill_id)special_clear_latch();
  return outcome;
}
static void special_poll_after_update(void) {
  static const u32 skills[6]={1001501,1001522,1001502,1001503,1001504,1001521};
  u64 now,end,elapsed;u32 i,latched,prior_injecting;int outcome;
  special_clock_t clock_fn=(special_clock_t)S->special_clock;
  if(!g_ready || !S->special_enabled || S->special_generation!=g_generation ||
     g_injecting || S->special_poll_running || !clock_fn)return;
  now=clock_fn();
  if(S->special_poll_clock_valid && now-S->special_last_poll<16)return;
  S->special_poll_clock_valid=1;S->special_last_poll=now;S->special_polls++;
  S->special_poll_running=1;
  if(special_active())goto finished;
  // Once the current runtime no longer resolves to this native object, keep
  // only copied diagnostic values. Never dereference it from RPC/status.
  S->special_tracked_skill=0;S->special_tracked_runtime=0;
  prior_injecting=g_injecting;g_injecting=1;
  latched=S->special_latched_skill_id;
  if(latched) {
    outcome=special_try(latched,latched>=1001521);
    if(outcome!=0)goto restore;
  }
  for(i=0;i<6;i++) {
    if(skills[i]==latched)continue;
    outcome=special_try(skills[i],skills[i]>=1001521);
    if(outcome!=0)break;
  }
restore:
  g_injecting=prior_injecting;
finished:
  end=clock_fn();elapsed=end>=now?end-now:0;
  S->special_total_poll_ms+=elapsed;
  if(elapsed>S->special_max_poll_ms)S->special_max_poll_ms=elapsed;
  S->special_poll_running=0;
}

static int request_evade_once(int allow_replace, struct melee_diag *diag) {
  if(S->special_enabled && special_active())return 0;
  if(S->dodge_disabled && !S->guard_request_active)return 0;
  u32 index;
  u32 selected;
  int outcome;

  if (!g_ready || g_injecting || g_player_logic == 0 ||
      g_use_skill == 0 || g_update_skill == 0 ||
      (!S->guard_request_active && g_action_candidate_count == 0) ||
      (!allow_replace && has_owned_active())) {
    return 0;
  }

  if(S->guard_request_active)return try_evade_candidate(0,diag)==1;
  selected = g_selected_action_index;
  if (selected < g_action_candidate_count) {
    outcome = try_evade_candidate(selected, diag);
    if (outcome != 0) return outcome == 1;
  }
  for (index = 0; index != g_action_candidate_count; index++) {
    if (index == selected) continue;
    outcome = try_evade_candidate(index, diag);
    if (outcome != 0) return outcome == 1;
  }
  S->native_selector_deferred++;
  if (diag != 0) diag->native_selector_deferred++;
  else S->ranged_request_diag.native_selector_deferred++;
  return 0;
}

// BFDAE0 is the game's normal terminal SkillLogic stop path. Only a
// trainer-owned Evade that is still the player's exact active runtime may be
// stopped, and the result is accepted only after native terminal state is
// visible. No timer, frame wait, or retry loop participates in this switch.
static int stop_owned_evade_for_restart(struct melee_diag *diag) {
  void *owned;
  u32 owned_runtime;
  u32 runtime_after;

  if (g_deactivate_skill == 0 || !has_owned_active()) return 0;
  owned = g_owned_evade;
  owned_runtime = g_owned_runtime;
  S->native_stops++;
  if (diag != 0) diag->native_stops++;

  g_injecting = 1;
  g_deactivate_skill(owned, 0);
  g_injecting = 0;

  runtime_after = read_u32(g_player_logic, LOGIC_RUNTIME_ID);
  if (runtime_after != owned_runtime || read_u8(owned, SKILL_ACTIVE) == 3) {
    S->stop_confirmed++;
    if (diag != 0) diag->stop_confirmed++;
    reset_owned();
    return 1;
  }

  S->stop_failed++;
  if (diag != 0) diag->stop_failed++;
  return 0;
}


// Ordinary Guard2 can naturally transition from Parry/Just into Type5 hold.
// Release only the exact trainer-created SkillLogic and runtime, from the
// native scheduler. A user's replacement runtime and every Dodge are excluded.
u32 guard_owned_pending(void) {
  if(!S->owned_guard || !g_owned_evade || !g_player_logic || !g_owned_runtime)return 0;
  return read_u32(g_player_logic,LOGIC_RUNTIME_ID)==g_owned_runtime &&
    read_u8(g_owned_evade,SKILL_ACTIVE)==1 &&
    read_pointer(g_owned_evade,0x68)==g_player_logic;
}
void begin_guard_drain(void){S->guard_draining=1;g_ready=0;}
static void release_owned_guard_on_update(void *skill) {
  void *step;
  if(g_injecting || !S->owned_guard || skill!=g_owned_evade || !guard_owned_pending())return;
  step=read_pointer(skill,SKILL_CURRENT_STEP);
  if(!S->guard_draining && !S->guard_unexpected_step &&
     (!step || read_u8(step,0x14)!=5))return;
  if(S->owned_guard_release_attempted)return;
  S->owned_guard_release_attempted=1;S->guard_stats[10]++;
  if(stop_owned_evade_for_restart(0))S->guard_stats[11]++;
}

static u32 diagnostic_float_bits(float value) {
  union { float f; u32 u; } bits;
  bits.f = value;
  return bits.u;
}

static int diagnostic_owned_is_current(void) {
  return g_player_logic != 0 && g_owned_evade != 0 && g_owned_runtime != 0 &&
    read_u32(g_player_logic, LOGIC_RUNTIME_ID) == g_owned_runtime &&
    read_u8(g_owned_evade, SKILL_ACTIVE) == 1;
}

static void reset_probe_diag(struct melee_diag *diag) {
  diag->angle_probe_seen = 0;
  diag->angle_result_al = 2; // unknown until the actual native branch runs
  diag->angle_source_match = 0;
  diag->angle_defender_match = 0;
  diag->angle_threshold_bits = 0;
  diag->angle_source_ptr = 0;
  diag->angle_defender_ptr = 0;
  diag->just_consumer_calls = 0;
  diag->just_consumer_matched = 0;
  diag->just_consumer_completed = 0;
  diag->just_consumer_result_type = 0;
  diag->just_consumer_descriptor = 0;
  diag->just_consumer_step_id = 0;
  diag->just_consumer_step_type = 0;
  diag->just_resolution_seen = 0;
  diag->just_resolution_descriptor = 0;
  diag->just_resolution_step_id = 0;
  diag->just_resolution_step_type = 0;
}

// Retained native fixture callback only. Never attach at the game branch:
// the v0.4 dump proved that a long detour overwrites an incoming jump target.
void angle_probe_on_enter(GumInvocationContext *ic) {
  GumCpuContext *cpu;
  struct melee_call_context *current;
  struct melee_diag *diag;
  u32 thread_id = GetCurrentThreadId();
  if (!g_ready || g_injecting || g_angle_probe_site == 0) return;
  current = &S->melee_call_contexts[thread_id % FILTER_THREAD_SLOTS];
  if (!current->active || current->thread_id != thread_id || current->generation != g_generation ||
      current->target != g_player_logic || current->source == 0 ||
      current->step == 0 || current->lease == 0 || !current->lease->attempted ||
      current->diag == 0 || !diagnostic_owned_is_current()) return;
  cpu = ic->cpu_context;
  if (cpu == 0 || (void *)cpu->rsi != current->source ||
      (void *)cpu->rdi != g_owned_evade ||
      read_pointer(current->source, SKILL_CURRENT_STEP) != current->step) return;
  diag = current->diag;
  init_angle(g_owned_evade, ((u64)cpu->rax) & 0xff);
  diag->angle_probe_seen++;
  diag->angle_result_al = ((u64)cpu->rax) & 0xff;
  diag->angle_source_ptr = (u64)cpu->rsi;
  diag->angle_defender_ptr = (u64)cpu->rdi;
  diag->angle_source_match = 1;
  diag->angle_defender_match = 1;
  if (diag->angle_source_match && diag->angle_defender_match) {
    void *row = read_pointer(g_owned_evade, 0x58);
    diag->angle_threshold_bits = row == 0 ? 0 :
      (u64)diagnostic_float_bits(read_f32(row, 0x118));
  }
}

// This site is immediately after the native Just descriptor resolution call;
// capture its actual RAX without changing execution.
void just_resolution_on_enter(GumInvocationContext *ic) {
  GumCpuContext *cpu;
  struct melee_call_context *current;
  void *descriptor;
  u32 thread_id = GetCurrentThreadId();
  if (!g_ready || g_injecting || !g_just_consumer) return;
  current = &S->melee_call_contexts[thread_id % FILTER_THREAD_SLOTS];
  if (!current->active || current->thread_id != thread_id ||
      current->generation != g_generation ||
      current->target != g_player_logic || current->lease == 0 ||
      !current->lease->attempted || current->diag == 0 ||
      !diagnostic_owned_is_current()) return;
  cpu = ic->cpu_context;
  if (cpu == 0 || (void *)cpu->rsi != current->source ||
      (void *)cpu->rdi != g_owned_evade || current->source == 0 ||
      read_pointer(current->source, SKILL_CURRENT_STEP) != current->step) return;
  descriptor = (void *)cpu->rax;
  current->diag->just_resolution_seen++;
  current->diag->just_resolution_descriptor = (u64)descriptor;
  if (descriptor != 0) {
    current->diag->just_resolution_step_id = read_u32(descriptor, STEP_ID);
    current->diag->just_resolution_step_type = read_u32(descriptor, STEP_TYPE);
  }
}

void just_consumer_on_enter(GumInvocationContext *ic) {
  struct just_probe_invocation *probe;
  struct melee_call_context *current;
  void *arg0;
  u32 thread_id;
  probe = gum_invocation_context_get_listener_invocation_data(ic, sizeof(*probe));
  if (probe == 0) return;
  probe->active = 0;
  probe->diag = 0;
  probe->owned = 0;
  if (!g_ready || g_injecting || g_just_consumer_return == 0 ||
      gum_invocation_context_get_return_address(ic) != g_just_consumer_return ||
      !diagnostic_owned_is_current()) return;
  thread_id = GetCurrentThreadId();
  current = &S->melee_call_contexts[thread_id % FILTER_THREAD_SLOTS];
  if (!current->active || current->thread_id != thread_id ||
      current->generation != g_generation ||
      current->target != g_player_logic || current->lease == 0 ||
      !current->lease->attempted || current->diag == 0) return;
  arg0 = gum_invocation_context_get_nth_argument(ic, 0);
  if (arg0 != g_owned_evade) return;
  probe->active = 1;
  probe->generation = g_generation;
  probe->thread_id = thread_id;
  probe->runtime = g_owned_runtime;
  probe->sequence = current->diag->attempt_sequence;
  probe->diag = current->diag;
  probe->owned = g_owned_evade;
  probe->source = current->source;
  probe->step = current->step;
  probe->diag->just_consumer_calls++;
  probe->diag->just_consumer_matched++;
  probe->diag->just_consumer_result_type =
    (u64)gum_invocation_context_get_nth_argument(ic, 3);
  probe->diag->just_consumer_descriptor =
    (u64)gum_invocation_context_get_nth_argument(ic, 1);
}

void just_consumer_on_leave(GumInvocationContext *ic) {
  struct just_probe_invocation *probe;
  struct melee_call_context *current;
  void *step;
  u32 thread_id = GetCurrentThreadId();
  if (!g_ready || g_injecting) return;
  probe = gum_invocation_context_get_listener_invocation_data(ic, sizeof(*probe));
  if (probe == 0 || !probe->active || probe->generation != g_generation ||
      probe->thread_id != thread_id || probe->diag == 0 ||
      probe->owned != g_owned_evade || probe->runtime != g_owned_runtime ||
      probe->sequence != probe->diag->attempt_sequence) return;
  current = &S->melee_call_contexts[thread_id % FILTER_THREAD_SLOTS];
  if (!current->active || current->thread_id != thread_id ||
      current->generation != g_generation || current->diag != probe->diag ||
      current->source != probe->source || current->step != probe->step) return;
  probe->diag->just_consumer_completed = 1;
  if (diagnostic_owned_is_current()) {
    step = read_pointer(g_owned_evade, 0x60);
    probe->diag->just_consumer_step_id = step == 0 ? 0 : read_u32(step, STEP_ID);
    probe->diag->just_consumer_step_type = step == 0 ? 0 : read_u32(step, STEP_TYPE);
  }
}

static int request_evade_native(struct melee_diag *diag) {
  struct melee_diag *trace = diag == 0 ? &S->ranged_request_diag : diag;
  void *step;
  void *row;
  int installed;
  u64 attempts_before = S->attempts;
  reset_probe_diag(trace);
  trace->native_request_submitted = 0;
  trace->attempt_sequence++;
  trace->attempt_accepted = 2;
  trace->runtime_before_request = g_player_logic == 0 ? 0 : read_u32(g_player_logic, LOGIC_RUNTIME_ID);
  trace->owned_snapshot_valid = 0;
  trace->owned_step_id = 0;
  trace->owned_step_type = 0;
  trace->owned_window_bits = 0;
  trace->owned_target_count = 0;
  trace->source_actor_key = 0;
  trace->source_in_owned_targets = 2;
  trace->result_step_id = 0;
  trace->result_window_bits = 0;
  trace->defender_gate_seen = 0;
  trace->defender_gate_passed = 0;
  trace->owned_row_alias_110 = 0;
  installed = request_evade_once(1, diag);
  trace->native_request_submitted = S->attempts != attempts_before;
  trace->attempt_installed = installed;
  trace->runtime_after_request = g_player_logic == 0 ? 0 : read_u32(g_player_logic, LOGIC_RUNTIME_ID);
  if (diagnostic_owned_is_current()) {
    step = read_pointer(g_owned_evade, SKILL_CURRENT_STEP);
    row = read_pointer(g_owned_evade, 0x58);
    trace->owned_snapshot_valid = 1;
    trace->owned_step_id = step == 0 ? 0 : read_u32(step, STEP_ID);
    trace->owned_step_type = step == 0 ? 0 : read_u32(step, STEP_TYPE);
    trace->owned_window_bits = diagnostic_float_bits(read_f32(g_owned_evade, SKILL_PERFECT_WINDOW));
    trace->owned_target_count = read_u32(g_owned_evade, 0x88);
    trace->owned_row_alias_110 = row == 0 ? 0 : read_u64(row, 0x110);
  }
  return installed;
}



typedef void *(*guard_manager_t)(void);
typedef void *(*guard_skill_lookup_t)(void*,void*,u32);
typedef void *(*guard_step_lookup_t)(void*,void*,u64*);
typedef u8 (*guard_query_t)(void*,u64*,void*,u8,void*,u32,float,float,u32,void*);
typedef void (*guard_free_t)(void*);
struct guard_target_array {void **data;u32 count;u32 capacity;};
void configure_guard_route(void *manager,void *skill_lookup,void *step_lookup,void *query,void *free_fn,u32 enabled) {
  S->guard_data_manager=manager;S->guard_skill_lookup=skill_lookup;S->guard_step_lookup=step_lookup;
  S->guard_target_query=query;S->guard_free=free_fn;S->guard_enabled=enabled!=0;
}
void read_guard_route_stats(u64 *out){u32 i;for(i=0;i<16;i++)out[i]=S->guard_stats[i];}
// SkillTable IDs, not CommandTable IDs. The native selector decides which
// current form can use a candidate. No stance flag or unlock is rewritten.
// Return the existing diagnostic reason: 0 ready, 2 no command, 3 bad row.
static u64 initial_guard_filter(void *skill,void *step) {
  u64 filter=step?read_u64(step,0x1b4):0;
  if(!filter && skill)filter=read_u64(skill,0xbc);
  if(!filter && skill)filter=read_u64(skill,0xb4);
  return filter;
}
struct guard_step_watch {void *row;u64 nonce;u32 generation;u32 thread;};
void guard_initial_step_enter(GumInvocationContext *ctx) {
  struct guard_step_watch *watch=gum_invocation_context_get_listener_invocation_data(ctx,sizeof(struct guard_step_watch));
  void *row=gum_invocation_context_get_nth_argument(ctx,1);
  watch->row=0;watch->nonce=0;watch->generation=0;watch->thread=0;
  if(!g_ready || !g_injecting || !S->guard_request_active ||
     row!=S->guard_expected_row || S->guard_request_generation!=g_generation ||
     S->guard_request_thread!=GetCurrentThreadId())return;
  watch->row=row;watch->nonce=S->guard_request_nonce;
  watch->generation=g_generation;watch->thread=GetCurrentThreadId();
}
void guard_initial_step_leave(GumInvocationContext *ctx) {
  struct guard_step_watch *watch=gum_invocation_context_get_listener_invocation_data(ctx,sizeof(struct guard_step_watch));
  void *result,*manager,*step;u64 alias;
  if(!watch->row || !g_ready || !g_injecting || !S->guard_request_active ||
     watch->row!=S->guard_expected_row || watch->nonce!=S->guard_request_nonce ||
     watch->generation!=g_generation || watch->thread!=GetCurrentThreadId())return;
  S->guard_capture_count++;
  result=gum_invocation_context_get_return_value(ctx);
  alias=result?read_u64(result,0):0;
  manager=S->guard_data_manager?((guard_manager_t)S->guard_data_manager)():0;
  step=manager&&alias&&S->guard_step_lookup?
    ((guard_step_lookup_t)S->guard_step_lookup)(manager,0,&alias):0;
  if(S->guard_capture_count!=1 || !step || read_u8(step,8)!=1 ||
     read_u8(step,STEP_TYPE)!=2 || read_u8(step,0x1a6) ||
     initial_guard_filter(watch->row,step)!=S->guard_expected_filter) {
    S->guard_capture_conflict=1;return;
  }
  S->guard_captured_step=step;
}
static int consistent_guard_initial_filters(void *manager,void *skill,void *first,u64 filter) {
  void *branches=read_pointer(skill,0x2f8),*step;u32 i,count=read_u32(skill,0x300);u64 alias;
  if(!filter || count>ACTION_CANDIDATE_CAPACITY || (count&&!branches))return 0;
  for(i=0;i<count;i++) {
    alias=read_u64(branches,i*16+8);
    step=alias?((guard_step_lookup_t)S->guard_step_lookup)(manager,0,&alias):0;
    if(!step || read_u8(step,8)!=1 || read_u8(step,STEP_TYPE)!=2 ||
       read_u8(step,0x1a6) || initial_guard_filter(skill,step)!=filter)return 0;
  }
  return 1;
}
static int resolve_native_guard_candidate(void *manager,void *command_manager,
    struct action_candidate *candidate,void **skill_out,void **step_out) {
  void *table,*node,*skill,*step;u64 key,first,filter;u32 i,id;
  if(!command_manager || !g_select_command_node)return 2;
  for(i=0;i<S->guard_candidate_count;i++) {
    id=S->guard_candidates[i].skill_id;
    node=g_select_command_node(command_manager,26,id,0.0f,0);
    if(!node || read_u32(node,COMMAND_NODE_INPUT_ID)!=26)continue;
    key=read_u64(node,COMMAND_NODE_FNAME);if(!key)continue;
    table=manager?read_pointer(manager,0x20):0;
    skill=table?((guard_skill_lookup_t)S->guard_skill_lookup)(table,0,id):0;
    if(!initialize_action_row(skill) || read_u32(skill,0x10)!=id ||
       !action_row_qualifies(skill,26))continue;
    first=read_u64(skill,0x100);
    step=first?((guard_step_lookup_t)S->guard_step_lookup)(manager,0,&first):0;
    if(!step || read_u8(step,8)!=1 || read_u8(step,STEP_TYPE)!=2 || read_u8(step,0x1a6))continue;
    filter=initial_guard_filter(skill,step);
    if(!consistent_guard_initial_filters(manager,skill,step,filter))continue;
    // The pass-through native observer captures the actual initial alias,
    // including effects/ActivatingSkill, inside this exact UseSkill request.
    S->guard_expected_row=skill;S->guard_expected_filter=filter;
    candidate->skill_id=id;candidate->command_key=key;
    *skill_out=skill;*step_out=step;return 0;
  }
  return 2;
}
static int choose_native_guard(struct melee_diag *diag) {
  void *manager,*skill,*step,*source,*command_manager;u64 filter;
  struct action_candidate candidate={0};
  struct guard_target_array targets={0};u32 i,prior_injecting;u8 queried;int matched=0,reason;
  if(!S->guard_enabled || !diag || !diag->source || !diag->step || !g_ready || g_injecting)return 0;
  S->guard_stats[0]++;S->guard_stats[13]=diag->step_id;S->guard_stats[14]=0;
  // Native response availability, not a colour classifier. Both ordinary
  // Parry and its Just response must be available on this source Step.
  if(read_u8(diag->step,0x2c)==0 || read_u8(diag->step,0x2f)==0) {
    S->guard_stats[1]++;S->guard_stats[14]=1;return 0;
  }
  if(!S->guard_data_manager || !S->guard_skill_lookup || !S->guard_step_lookup ||
     !S->guard_target_query || !S->guard_free)return 0;
  source=read_pointer(diag->source,0x68);
  if(!source || source==g_player_logic)return 0;
  command_manager=g_player_actor?read_pointer(g_player_actor,ACTOR_COMMAND_MANAGER):0;
  manager=((guard_manager_t)S->guard_data_manager)();
  reason=resolve_native_guard_candidate(manager,command_manager,&candidate,&skill,&step);
  if(reason) {
    S->guard_stats[reason]++;S->guard_stats[14]=reason;return 0;
  }
  filter=read_u64(step,0x1b4);
  if(!filter) {
    if(g_player_actor && read_pointer(g_player_actor,0x630))filter=read_u64(skill,0xbc);
    if(!filter)filter=read_u64(skill,0xb4);
  }
  if(!filter){S->guard_stats[3]++;S->guard_stats[14]=3;return 0;}
  // Same native target-query ABI used by BF8E70. The engine supplies the
  // current position/front/right and filter geometry; no custom cone test.
  prior_injecting=g_injecting;g_injecting=1;
  queried=((guard_query_t)S->guard_target_query)(g_player_logic,&filter,&targets,1,0,
    read_u8(skill,0x75),0.0f,0.3f,0xffff0000U,0);
  if(queried && targets.data && targets.count<=1024) {
    for(i=0;i<targets.count;i++)if(targets.data[i]==source){matched=1;break;}
  }
  if(targets.data)((guard_free_t)S->guard_free)(targets.data);
  g_injecting=prior_injecting;
  S->guard_stats[4]++;
  if(!matched){S->guard_stats[5]++;S->guard_stats[14]=4;return 0;}
  S->guard_candidate=candidate;
  S->guard_stats[6]++;S->guard_stats[14]=5;return 1;
}
static int request_combined_melee(struct melee_diag *diag) {
  u64 attempts_before;int result;
  if(!choose_native_guard(diag)) {
    S->guard_stats[12]++;return request_evade_native(diag);
  }
  attempts_before=S->attempts;S->guard_request_active=1;
  result=request_evade_native(diag);
  S->guard_request_active=0;
  if(S->attempts!=attempts_before) {
    S->guard_stats[7]++;
    if(result){S->guard_stats[8]++;S->guard_stats[14]=6;}
    else{S->guard_stats[9]++;S->guard_stats[14]=7;}
    // A real native request is single-shot, same as v10. Do not emit a
    // second action after a submitted guard's uncertain native outcome.
    return result;
  }
  // Selection ceased to be available; no Guard was issued or token spent.
  S->guard_stats[12]++;return request_evade_native(diag);
}

// Build 24463856: BEF780 calls C75850 with positional float arguments in
// XMM1 and stack slot 7. With slot 7 zero this is the native geometry query.
typedef void *(*projectile_row_lookup_t)(void*,void*,u64*);
typedef u8 (*projectile_guard_geometry_t)(const float*,float,const u64*,
  const float*,const float*,const float*,float,u32);
typedef u8 (*projectile_actor_state_t)(void*,u32);
void configure_projectile_guard(void *row_lookup,void *geometry,void *actor_state) {
  S->projectile_guard_row_lookup=row_lookup;
  S->projectile_guard_geometry=geometry;
  S->projectile_guard_actor_state=actor_state;
}
void read_projectile_guard_stats(u64 *out){u32 i;for(i=0;i<12;i++)out[i]=S->projectile_guard_stats[i];}
static int choose_native_projectile_guard(void *projectile,void *record) {
  void *manager,*row,*skill,*step,*command_manager;
  struct action_candidate candidate={0};
  u64 key,filter;u32 i;u8 accepted;int reason;
  float point[4]={0},origin[4]={0},front[4]={0},right[4]={0};
  if(!S->guard_enabled || !g_ready || g_injecting || !projectile ||
     !g_player_actor || !g_player_logic)return 0;
  S->projectile_guard_stats[0]++;
  if(!record || !S->projectile_guard_row_lookup ||
     !S->projectile_guard_geometry || !S->projectile_guard_actor_state ||
     !S->guard_data_manager || !S->guard_skill_lookup || !S->guard_step_lookup ||
     !S->select_command_node){S->projectile_guard_stats[1]++;return 0;}
  manager=((guard_manager_t)S->guard_data_manager)();
  key=read_u64(projectile,0x58);
  row=manager&&key?((projectile_row_lookup_t)S->projectile_guard_row_lookup)(manager,0,&key):0;
  // Native projectile availability. +0x121 is SuperParry, not JustParry.
  if(!row || !read_u8(row,0x120) || !read_u8(row,0x123)){
    S->projectile_guard_stats[2]++;return 0;
  }
  command_manager=read_pointer(g_player_actor,ACTOR_COMMAND_MANAGER);
  reason=resolve_native_guard_candidate(manager,command_manager,&candidate,&skill,&step);
  if(reason){S->projectile_guard_stats[reason==2?3:4]++;return 0;}
  if(read_f32(skill,0x118)!=0.0f){
    S->projectile_guard_stats[4]++;return 0;
  }
  filter=read_u64(step,0x1b4);
  if(!filter){
    if(read_pointer(g_player_actor,0x630))filter=read_u64(skill,0xbc);
    if(!filter)filter=read_u64(skill,0xb4);
  }
  if(!filter){S->projectile_guard_stats[4]++;return 0;}
  if(((projectile_actor_state_t)S->projectile_guard_actor_state)(g_player_actor,31)){
    S->projectile_guard_stats[5]++;return 0;
  }
  if(!native_actor_position(g_player_logic,origin)){S->projectile_guard_stats[6]++;return 0;}
  for(i=0;i<3;i++){
    // This exact BED550 hit record is passed as BEF780 arg3. Its +0x2c
    // point, not the unrelated +0x64 copy, feeds the original geometry.
    point[i]=read_f32(record,0x2c+i*4);
    front[i]=read_f32(g_player_actor,0x4f0+i*4);
    right[i]=read_f32(g_player_actor,0x4fc+i*4);
    if(!finite_input_float(point[i]) || !finite_input_float(front[i]) ||
       !finite_input_float(right[i])){S->projectile_guard_stats[6]++;return 0;}
  }
  accepted=((projectile_guard_geometry_t)S->projectile_guard_geometry)(
    point,0.0f,&filter,origin,front,right,0.0f,0xffff0000U);
  S->projectile_guard_stats[7]++;
  if(!accepted){S->projectile_guard_stats[8]++;return 0;}
  S->guard_candidate=candidate;
  S->projectile_guard_stats[9]++;return 1;
}
static int request_evade_for_projectile(void *projectile_logic,void *record,int *guard_qualified) {
  void *previous=S->request_source_actor;int result,qualified;u64 attempts_before;
  S->request_source_actor=projectile_logic?read_pointer(projectile_logic,0x70):0;
  qualified=choose_native_projectile_guard(projectile_logic,record);
  if(guard_qualified)*guard_qualified=qualified;
  if(qualified){
    attempts_before=S->attempts;S->guard_request_active=1;
    result=request_evade_native(0);
    S->guard_request_active=0;
    if(S->attempts!=attempts_before){
      S->guard_stats[7]++;
      if(result){S->guard_stats[8]++;S->projectile_guard_stats[10]++;}
      else{S->guard_stats[9]++;S->projectile_guard_stats[11]++;}
      // A submitted Guard consumes this attempt even if native UseSkill
      // refuses it. Never issue a second action after that real request.
      S->request_source_actor=previous;return result;
    }
  }
  result=request_evade_native(0);
  S->request_source_actor=previous;
  return result;
}

static struct lease begin_lease(void) {
  struct lease result;
  float before;
  result.skill_logic = 0;
  result.step = 0;
  result.runtime = 0;
  result.original = 0.0f;
  result.active = 0;
  result.attempted = 0;
  if (S->owned_guard || !has_owned_active()) return result;
  result.skill_logic = g_owned_evade;
  result.step = read_pointer(result.skill_logic, SKILL_CURRENT_STEP);
  before = read_f32(result.skill_logic, SKILL_PERFECT_WINDOW);
  if (result.step == 0 || before >= 6.0f) return result;
  result.runtime = g_owned_runtime;
  result.original = before;
  write_f32(result.skill_logic, SKILL_PERFECT_WINDOW, 6.0f);
  result.active = 1;
  return result;
}

static void end_lease(struct lease lease) {
  if (!lease.active || g_player_logic == 0) return;
  if (read_u32(g_player_logic, LOGIC_RUNTIME_ID) != lease.runtime ||
      read_pointer(lease.skill_logic, SKILL_CURRENT_STEP) != lease.step ||
      read_f32(lease.skill_logic, SKILL_PERFECT_WINDOW) != 6.0f) {
    return;
  }
  write_f32(lease.skill_logic, SKILL_PERFECT_WINDOW, lease.original);
}

static int request_qualified_melee(struct melee_call_context *call) {
  struct melee_diag *diag;
  struct repeat_phase phase;
  struct melee_pending *pending;
  u32 i;
  int recheck_pending = 0, installed, valid_phase;
  u64 attempts_before, null_before;
  if (!call || !g_ready || call->generation != g_generation ||
      !call->source || !call->step || call->target != g_player_logic) return 0;
  // Only the source passed by this live invocation is dereferenced. Retiring
  // stale table entries compares identities, never dereferences old pointers.
  if (read_pointer(call->source, SKILL_CURRENT_STEP) != call->step ||
      read_u32(call->source, SKILL_RESULT_EPOCH) != call->source_epoch) {
    for (i=0;i<MELEE_DIAG_CAPACITY;i++)
      if (S->melee_pending[i].source == call->source) invalidate_melee_pending(&S->melee_pending[i]);
    return 0;
  }
  diag = call->diag;
  pending = find_melee_pending(call->source,call->step,call->source_epoch);
  valid_phase = capture_repeat_phase(&phase);
  if (pending) {
    if (!valid_phase || phase.runtime != pending->player_runtime ||
        phase.active_skill != pending->active_skill) {
      invalidate_melee_pending(pending);
      remember_melee_step(call->source,call->step,call->source_epoch);
      sweep_melee_pending();
      return 0;
    }
    if (melee_pending_same_phase(pending,&phase)) {
      S->pending_deferrals++;
      return 1;
    }
    clear_melee_pending(pending);
    S->pending_rechecks++;
    recheck_pending = 1;
  }
  sweep_melee_pending();
  for (i=0;i<MELEE_DIAG_CAPACITY;i++) {
    pending=&S->melee_pending[i];
    if (pending->active && pending->source==call->source &&
        (pending->source_step!=call->step || pending->source_epoch!=call->source_epoch))
      invalidate_melee_pending(pending);
  }
  if (has_melee_step(call->source,call->step,call->source_epoch)) {
    if (diag) diag->duplicate_suppressed++;
  } else {
    attempts_before=S->attempts;
    null_before=S->request_returned_null;
    if (has_owned_active()) {
      S->old_owned_active++;
      if (diag) {diag->blocked_active++;diag->old_owned_active++;}
    }
    installed=request_combined_melee(diag);
    if (S->attempts!=attempts_before) {
      if (diag) diag->requests++;
      if (call->lease) call->lease->attempted=1;
      if (installed) {
        if (diag) diag->installed++;
        if (recheck_pending) S->installed_after_wait++;
      } else if (S->request_returned_null>null_before && valid_phase &&
          read_pointer(call->source,SKILL_CURRENT_STEP)==call->step &&
          read_u32(call->source,SKILL_RESULT_EPOCH)==call->source_epoch &&
          set_melee_pending(call->source,call->step,call->source_epoch,&phase)) {
        S->pending_deferrals++;
        return 1;
      }
      // Success and every non-deferrable failure are single-shot. A full
      // pending table never turns a refusal into a repeated native request.
      remember_melee_step(call->source,call->step,call->source_epoch);
    }
  }
  if (call->lease && !call->lease->active) {
    int attempted=call->lease->attempted;
    *call->lease=begin_lease();call->lease->attempted=attempted;
  }
  return 0;
}

// Native C08B40 is a read-only per-target result-map predicate. Match only
// the source map in the active player-target BFE9E0 invocation. Its second
// defender-map call and every unrelated use of C08B40 are left alone.
void melee_source_gate_on_enter(GumInvocationContext *ic) {
  struct melee_call_context *invocation;
  struct melee_call_context *current;
  u32 thread_id = GetCurrentThreadId();
  invocation = gum_invocation_context_get_listener_invocation_data(ic, sizeof(*invocation));
  if (invocation == 0) return;
  invocation->active = 0;
  if (!g_ready || g_injecting) return;
  current = &S->melee_call_contexts[thread_id % FILTER_THREAD_SLOTS];
  if (!current->active || current->thread_id != thread_id ||
      current->generation != g_generation || current->target != g_player_logic ||
      current->source == 0 || current->step == 0) return;
  if (gum_invocation_context_get_nth_argument(ic, 0) == (u8 *)current->source + SKILL_RESULT_MAP) {
    if (g_melee_source_gate_caller_return != 0 &&
        gum_invocation_context_get_return_address(ic) != g_melee_source_gate_caller_return) return;
    *invocation = *current;
    invocation->gate_kind = 1;
    return;
  }
  if (!diagnostic_owned_is_current() ||
      gum_invocation_context_get_nth_argument(ic, 0) != (u8 *)g_owned_evade + SKILL_RESULT_MAP) return;
  *invocation = *current;
  invocation->gate_kind = 2;
  invocation->gate_key = (u32)(u64)gum_invocation_context_get_nth_argument(ic, 1);
}

void melee_source_gate_on_leave(GumInvocationContext *ic) {
  struct melee_call_context *invocation;
  struct melee_call_context *current;
  u32 thread_id = GetCurrentThreadId();
  invocation = gum_invocation_context_get_listener_invocation_data(ic, sizeof(*invocation));
  if (invocation == 0 || !invocation->active || !g_ready || g_injecting) return;
  current = &S->melee_call_contexts[thread_id % FILTER_THREAD_SLOTS];
  if (!current->active || current->thread_id != thread_id ||
      current->generation != invocation->generation || invocation->generation != g_generation ||
      current->source != invocation->source || current->step != invocation->step ||
      current->lease != invocation->lease || current->target != g_player_logic ||
      read_pointer(invocation->source, SKILL_CURRENT_STEP) != invocation->step) return;
  if (invocation->gate_kind == 2) {
    struct melee_diag *diag = invocation->diag;
    if (diag != 0 && invocation->lease != 0 && invocation->lease->attempted) {
      diag->defender_gate_seen = 1;
      diag->defender_gate_passed = ((u64)gum_invocation_context_get_return_value(ic) & 0xff) != 0;
      diag->source_actor_key = invocation->gate_key;
      if (diagnostic_owned_is_current()) {
        u32 count = read_u32(g_owned_evade, 0x88);
        u32 *targets = read_pointer(g_owned_evade, 0x80);
        u32 i;
        if (count <= 64 && (count == 0 || targets != 0)) {
          diag->source_in_owned_targets = 0;
          for (i = 0; i < count; i++) {
            if (targets[i] == invocation->gate_key) {
              diag->source_in_owned_targets = 1;
              break;
            }
          }
        }
      }
    }
    return;
  }
  if (invocation->diag != 0) invocation->diag->source_gate_calls++;
  if (((u64)gum_invocation_context_get_return_value(ic) & 0xff) == 0) {
    if (invocation->diag != 0) invocation->diag->source_gate_false++;
    return;
  }
  if (invocation->diag != 0) invocation->diag->source_gate_true++;
  if (request_qualified_melee(invocation)) {
    // The first C08B40 predicate is the native early-return gate. Deferring
    // here prevents the later native result/commit path from consuming a
    // refused request while retaining the phase-bound pending record.
    gum_invocation_context_replace_return_value(ic, 0);
  }
}

u32 melee_wrapper(void *source_skill_logic, void *target_logic, void *arg2, void *arg3) {
  struct lease lease = {0};
  struct melee_diag *diag;
  struct melee_call_context *current;
  struct melee_call_context previous;
  void *source_step;
  u32 source_epoch;
  u32 thread_id;
  u32 result;
  if (g_melee_original == 0) return 0;
  S->melee_calls++;
  if (g_injecting || !g_ready || target_logic != g_player_logic) {
    return g_melee_original(source_skill_logic, target_logic, arg2, arg3);
  }
  source_step = read_pointer(source_skill_logic, SKILL_CURRENT_STEP);
  source_epoch = read_u32(source_skill_logic, SKILL_RESULT_EPOCH);
  health_note_source(1,source_skill_logic,read_u32(source_step,STEP_ID),0);
  diag = get_melee_diag(source_skill_logic, source_step, source_epoch);
  if (diag != 0) diag->calls++;
  thread_id = GetCurrentThreadId();
  current = &S->melee_call_contexts[thread_id % FILTER_THREAD_SLOTS];
  previous = *current;
  current->thread_id = thread_id;
  current->generation = g_generation;
  current->source_epoch = source_epoch;
  current->source = source_skill_logic;
  current->step = source_step;
  current->target = target_logic;
  current->diag = diag;
  current->lease = &lease;
  current->active = 1;
  result = g_melee_original(source_skill_logic, target_logic, arg2, arg3);
  *current = previous;
  health_note_source(1,source_skill_logic,read_u32(source_step,STEP_ID),result);
  if (diag != 0) {
    diag->last_result = result;
    diag->epoch_after = read_u32(source_skill_logic, SKILL_RESULT_EPOCH);
    diag->interaction = (u64)arg2;
    diag->interaction_class = arg2 == 0 ? 0 : read_u32(arg2, 0xb8);
    diag->out_accepted = arg3 == 0 ? 0 : read_u8(arg3, 0);
    if (arg3 != 0) {
      if (diag->out_accepted) diag->accepted_true++;
      else diag->accepted_false++;
    }
    if (lease.attempted) {
      diag->attempt_accepted = arg3 == 0 ? 2 : read_u8(arg3, 0);
      if (diagnostic_owned_is_current()) {
        void *owned_step = read_pointer(g_owned_evade, SKILL_CURRENT_STEP);
        diag->result_step_id = owned_step == 0 ? 0 : read_u32(owned_step, STEP_ID);
        diag->result_window_bits = diagnostic_float_bits(read_f32(g_owned_evade, SKILL_PERFECT_WINDOW));
      }
    }
  }
  end_lease(lease);
  return result;
}

// Observe the game's own SkillLogic scheduler. Manual activation enters the
// public address while g_injecting is set and is deliberately not counted.
u8 update_skill_wrapper(void *skill_logic, float delta) {
  int owned_before;
  int any_owned_before;
  u8 result;
  if (g_update_original == 0) return 0;
  health_sample_player(skill_logic);
  if(S->action_trace_update && g_ready && !g_injecting && skill_logic &&
      g_player_logic && read_pointer(skill_logic,0x68)==g_player_logic)
    ((void(*)(void*))S->action_trace_update)(skill_logic);
  observe_melee_source_lifecycle(skill_logic);
  any_owned_before =
    !g_injecting && g_ready && skill_logic != 0 &&
    skill_logic == g_owned_evade && g_player_logic != 0 &&
    g_owned_runtime != 0 &&
    read_u32(g_player_logic, LOGIC_RUNTIME_ID) == g_owned_runtime;
  owned_before =
    !g_injecting && g_ready && skill_logic != 0 &&
    skill_logic == S->ranged_wait_evade && skill_logic == g_owned_evade &&
    g_player_logic != 0 && S->ranged_wait_runtime != 0 &&
    read_u32(g_player_logic, LOGIC_RUNTIME_ID) == S->ranged_wait_runtime;
  struct init_record *init_record = init_natural_before(skill_logic, delta);
  u64 init_sequence = init_record == 0 ? 0 : init_record->h[0];
  result = g_update_original(skill_logic, delta);
  init_natural_after(init_record, init_sequence, skill_logic);
  release_owned_guard_on_update(skill_logic);
  observe_melee_source_lifecycle(skill_logic);
  if (any_owned_before) {
    S->natural_bfd340_seen++;
    if (S->owned_diag != 0 &&
        S->owned_diag->generation == g_generation &&
        S->owned_diag->source == S->owned_diag_source &&
        S->owned_diag->step == S->owned_diag_step) {
      S->owned_diag->natural_bfd340_seen++;
    }
  }
  if (owned_before &&
      read_u32(g_player_logic, LOGIC_RUNTIME_ID) == S->ranged_wait_runtime &&
      read_u8(skill_logic, SKILL_ACTIVE) == 1) {
    S->owned_natural_updates++;
  }
  special_poll_after_update();
  return result;
}

static struct builder_thread_slot *get_builder_slot(u32 thread_id) {
  return &g_builder_slots[thread_id % FILTER_THREAD_SLOTS];
}

static struct actor_resolve_slot *get_actor_resolve_slot(u32 thread_id) {
  return &g_actor_resolve_slots[thread_id % FILTER_THREAD_SLOTS];
}

static struct projectile_gate_slot *get_projectile_gate_slot(u32 thread_id) {
  return &S->gate_slots[thread_id % FILTER_THREAD_SLOTS];
}

static int ranged_wait_evade_is_active(void) {
  if (S->ranged_wait_evade == 0 || S->ranged_wait_runtime == 0 ||
      S->ranged_wait_evade != g_owned_evade ||
      S->ranged_wait_runtime != g_owned_runtime) {
    return 0;
  }
  return has_owned_active();
}

static int projectile_wait_is_naturally_ready(struct projectile_token *token) {
  return token != 0 && token->state == PROJECTILE_WAITING &&
    ranged_wait_evade_is_active() &&
    S->owned_natural_updates > token->natural_updates_at_claim;
}

// C08B40 is the game's own last eligibility decision for this exact BEF780
// interaction. A raw collision record can be a graze; it must never enter
// this state machine as an action request.
static int handle_projectile_eligibility_true(struct projectile_gate_slot *slot) {
  struct projectile_token *token;

  if (slot == 0 || slot->projectile == 0 ||
      slot->target_logic != g_player_logic) return 0;
  token = find_projectile_target(
    slot->projectile, g_player_actor, slot->projectile_id
  );
  if (token == 0) {
    token = create_projectile_target(
      slot->projectile, g_player_actor, slot->projectile_id
    );
    if (token == 0) return 0;
  }

  S->gate_true_seen++;
  S->player_matches++;
  if (token->gate_seen != 0) S->same_projectile_gate_reentered++;
  token->gate_seen++;

  // A subsequent BEF780 call after a settled result is a new native
  // interaction. Do not tear down the existing action: wait for its natural
  // lifecycle, then make one fresh request at a future eligible gate.
  if (token->state == PROJECTILE_SETTLED) {
    token->state = PROJECTILE_REARM_WAITING;
    token->natural_updates_at_claim = 0;
  }
  if (token->state == PROJECTILE_FAIL_OPEN) {
    token->state = 0;
    token->natural_updates_at_claim = 0;
    S->rearmed_attacks++;
  }

  if (token->state == PROJECTILE_REARM_WAITING) {
    if (has_owned_active()) {
      S->waiting_defers++;
      S->gate_suppressed++;
      return 1;
    }
    token->state = 0;
    token->natural_updates_at_claim = 0;
    S->rearmed_attacks++;
  }

  if (token->state == 0) {
    int guard_qualified=0;
    int installed = request_evade_for_projectile(slot->projectile,0,&guard_qualified);
    if (S->ranged_request_diag.native_request_submitted) S->action_claims++;
    if (installed) {
      S->deferred_projectile = slot->projectile;
      S->ranged_wait_evade = g_owned_evade;
      S->ranged_wait_runtime = g_owned_runtime;
      token->state = PROJECTILE_WAITING;
      token->natural_updates_at_claim = S->owned_natural_updates;
      S->deferred_hits++;
      S->waiting_defers++;
      S->gate_suppressed++;
      return 1;
    }
    if(S->dodge_disabled && !guard_qualified)return 0;
    if (has_owned_active()) {
      token->state = PROJECTILE_REARM_WAITING;
      S->waiting_defers++;
      S->gate_suppressed++;
      return 1;
    }
    if (!S->ranged_request_diag.native_request_submitted) return 0;
    token->state = PROJECTILE_FAIL_OPEN;
    S->fail_open_releases++;
    return 0;
  }

  if (token->state == PROJECTILE_WAITING) {
    if (projectile_wait_is_naturally_ready(token)) {
      token->state = PROJECTILE_RELEASED;
      S->released_after_update++;
      S->released_original_true++;
      return 0;
    }
    if (!ranged_wait_evade_is_active()) {
      token->state = PROJECTILE_FAIL_OPEN;
      S->ranged_wait_evade = 0;
      S->ranged_wait_runtime = 0;
      S->fail_open_releases++;
      return 0;
    }
    S->waiting_defers++;
    S->gate_suppressed++;
    return 1;
  }

  // RELEASED only occurs after the natural BFD340 transition. Preserve the
  // game's true return for every re-entry inside the same arbitration call.
  return 0;
}

static int handle_filtered_player_record(
    void *projectile_logic, u32 projectile_id, u64 builder_sequence,
    u32 primary_count, u32 secondary_count,void *record) {
  struct projectile_token *token;
  struct repeat_phase phase;
  int valid_phase;
  int recheck_pending = 0;
  u64 null_before;
  int wait_active;
  if(S->dodge_disabled && !S->guard_enabled)return 0;
  token = find_projectile_target(projectile_logic, g_player_actor, projectile_id);
  if (token == 0) {
    token = create_projectile_target(projectile_logic, g_player_actor, projectile_id);
    if (token == 0) return 0;
  } else if (token->state == PROJECTILE_SETTLED) {
    // The previous interaction reached BEF780's native result consumer. Keep
    // the next filtered player interaction pending until the game naturally
    // ends the owned Evade; do not tear it down or use a time/count delay.
    token->state = PROJECTILE_REARM_WAITING;
    token->natural_updates_at_claim = 0;
  }

  if (token->state == PROJECTILE_REARM_WAITING) {
    S->retry_hits++;
    if (has_owned_active()) {
      S->waiting_defers++;
      return 1;
    }
    token->state = 0;
    token->natural_updates_at_claim = 0;
    S->rearmed_attacks++;
  }

  if (token->state == PROJECTILE_PENDING) {
    valid_phase = capture_repeat_phase(&phase);
    if (!valid_phase || token->generation != g_generation ||
        token->target_actor != g_player_actor || projectile_logic == 0 ||
        read_u32(projectile_logic, PROJECTILE_RUNTIME_ID) != projectile_id) {
      clear_projectile_pending(token, 1);
      token->state = 0;
      return 0;
    }
    if (projectile_pending_same_phase(token, &phase)) {
      S->pending_deferrals++;
      S->waiting_defers++;
      return 1;
    }
    if (phase.runtime != token->pending_runtime ||
        phase.active_skill != token->pending_active_skill) {
      clear_projectile_pending(token, 1);
      token->state = 0;
      return 0;
    }
    S->pending_rechecks++;
    clear_projectile_pending(token, 0);
    token->state = 0;
    recheck_pending = 1;
  }

  S->current_player_builder_sequence = builder_sequence;
  if (token->state == 0) {
    int guard_qualified=0;
    valid_phase = capture_repeat_phase(&phase);
    null_before = S->request_returned_null;
    int installed = request_evade_for_projectile(projectile_logic,record,&guard_qualified);
    if (S->ranged_request_diag.native_request_submitted) S->action_claims++;
    if (installed) {
      S->primary_num_at_defer = primary_count;
      S->secondary_num_at_defer = secondary_count;
      S->deferred_projectile = projectile_logic;
      S->ranged_wait_evade = g_owned_evade;
      S->ranged_wait_runtime = g_owned_runtime;
      S->deferred_builder_sequence = builder_sequence;
      token->state = PROJECTILE_WAITING;
      clear_projectile_pending(token, 0);
      if (recheck_pending) S->installed_after_wait++;
      token->natural_updates_at_claim = S->owned_natural_updates;
      S->deferred_hits++;
      S->waiting_defers++;
      return 1;
    }
    if(S->dodge_disabled && !guard_qualified)return 0;
    if (has_owned_active()) {
      token->state = PROJECTILE_REARM_WAITING;
      S->waiting_defers++;
      return 1;
    }
    if (S->ranged_request_diag.native_request_submitted &&
        S->request_returned_null > null_before && valid_phase &&
        projectile_logic != 0 &&
        read_u32(projectile_logic, PROJECTILE_RUNTIME_ID) == projectile_id &&
        set_projectile_pending(token, &phase)) {
      S->pending_deferrals++;
      S->waiting_defers++;
      return 1;
    }
    // A non-null incomplete request remains fail-open. A refused request with
    // no phase context also remains visible to the game's original path.
    if (!S->ranged_request_diag.native_request_submitted) return 0;
    token->state = PROJECTILE_FAIL_OPEN;
    return 0;
  }

  S->retry_hits++;
  if (token->state == PROJECTILE_WAITING) {
    wait_active = ranged_wait_evade_is_active();
    if (wait_active &&
        S->owned_natural_updates > token->natural_updates_at_claim) {
      token->state = PROJECTILE_RELEASED;
      S->released_after_update++;
      return 0;
    }
    if (!wait_active) {
      token->state = PROJECTILE_FAIL_OPEN;
      S->ranged_wait_evade = 0;
      S->ranged_wait_runtime = 0;
      S->fail_open_releases++;
      return 0;
    }
    S->waiting_defers++;
    return 1;
  }
  return 0;
}

static int handle_filtered_player(void *projectile_logic,u32 projectile_id,
    u64 builder_sequence,u32 primary_count,u32 secondary_count) {
  return handle_filtered_player_record(projectile_logic,projectile_id,
    builder_sequence,primary_count,secondary_count,0);
}

// BF2B40 now records only the current thread's raw array range. Ranged action
// selection occurs later, after BED550 has applied its native pre-delete.
u8 hit_records_wrapper(void *projectile_logic, void *out_hit_records, void *out_secondary) {
  struct builder_thread_slot *slot;
  u8 result;
  u32 count;
  u32 secondary_count;
  u32 secondary_capacity;
  u32 thread_id;

  if (g_hit_records_original == 0) return 0;
  S->hit_builder_calls++;
  result = g_hit_records_original(projectile_logic, out_hit_records, out_secondary);
  thread_id = GetCurrentThreadId();
  slot = get_builder_slot(thread_id);
  slot->thread_id = thread_id;
  slot->generation = g_generation;
  slot->projectile = 0;
  slot->data = 0;
  slot->count = 0;
  slot->projectile_id = 0;
  slot->sequence = ++S->hit_builder_sequence;
  slot->secondary_count = 0;
  if (!result || !g_ready || g_injecting || projectile_logic == 0 ||
      out_hit_records == 0) return result;
  count = read_u32(out_hit_records, 8);
  if (count == 0 || count > HIT_RECORD_LIMIT) return result;
  slot->data = read_pointer(out_hit_records, 0);
  if (slot->data == 0) return result;
  secondary_count = out_secondary == 0 ? 0 : read_u32(out_secondary, 8);
  secondary_capacity = out_secondary == 0 ? 0 : read_u32(out_secondary, 12);
  if (secondary_count > secondary_capacity || secondary_capacity > 4096) {
    secondary_count = 0xffffffffU;
  }
  slot->projectile = projectile_logic;
  slot->count = count;
  slot->projectile_id = read_u32(projectile_logic, PROJECTILE_RUNTIME_ID);
  slot->secondary_count = secondary_count;
  return result;
}

void actor_resolve_on_enter(GumInvocationContext *ic) {
  struct actor_resolve_slot *resolve_slot;
  struct builder_thread_slot *builder_slot;
  void *record;
  u32 thread_id;
  u64 delta;
  if (!g_ready || g_injecting ||
      gum_invocation_context_get_return_address(ic) != g_filtered_actor_caller_return) {
    return;
  }
  thread_id = GetCurrentThreadId();
  builder_slot = get_builder_slot(thread_id);
  if (builder_slot->thread_id != thread_id ||
      builder_slot->generation != g_generation ||
      builder_slot->projectile == 0 || builder_slot->data == 0 ||
      builder_slot->count == 0 || builder_slot->count > HIT_RECORD_LIMIT) {
    return;
  }
  record = gum_invocation_context_get_nth_argument(ic, 1);
  if ((u64)record < (u64)builder_slot->data) return;
  delta = (u64)record - (u64)builder_slot->data;
  if (delta % HIT_RECORD_STRIDE != 0 ||
      delta / HIT_RECORD_STRIDE >= builder_slot->count) return;
  resolve_slot = get_actor_resolve_slot(thread_id);
  resolve_slot->thread_id = thread_id;
  resolve_slot->active = 1;
  resolve_slot->projectile = builder_slot->projectile;
  resolve_slot->record = record;
  resolve_slot->projectile_id = builder_slot->projectile_id;
  resolve_slot->sequence = builder_slot->sequence;
}

void actor_resolve_on_leave(GumInvocationContext *ic) {
  struct actor_resolve_slot *resolve_slot;
  struct builder_thread_slot *builder_slot;
  void *resolved_actor;
  u32 thread_id;
  int suppress;
  if (gum_invocation_context_get_return_address(ic) != g_filtered_actor_caller_return) return;
  thread_id = GetCurrentThreadId();
  resolve_slot = get_actor_resolve_slot(thread_id);
  if (!resolve_slot->active || resolve_slot->thread_id != thread_id) return;
  resolve_slot->active = 0;
  resolved_actor = gum_invocation_context_get_return_value(ic);
  if (!g_ready || g_injecting || resolved_actor != g_player_actor) return;
  builder_slot = get_builder_slot(thread_id);
  S->player_matches++;
  suppress = handle_filtered_player_record(
    resolve_slot->projectile, resolve_slot->projectile_id,
    resolve_slot->sequence,
    builder_slot->count, builder_slot->secondary_count,resolve_slot->record
  );
  if (suppress) gum_invocation_context_replace_return_value(ic, 0);
}

// BEF780 remains the native result-time consumer. Ranged Evade is started by
// the filtered BED550 record path and released only after a natural BFD340.
u8 projectile_wrapper(void *projectile_logic, void *target_logic, void *arg2, void *arg3) {
  if(S->dodge_disabled && !S->guard_enabled)return g_projectile_original?g_projectile_original(projectile_logic,target_logic,arg2,arg3):0;
  struct lease lease;
  struct projectile_token *token;
  u8 result;
  if (g_projectile_original == 0) return 0;
  S->projectile_calls++;
  if (projectile_logic == S->deferred_projectile &&
      S->deferred_builder_sequence != 0) {
    if (S->current_player_builder_sequence == S->deferred_builder_sequence) {
      S->same_builder_result_calls++;
    } else if (S->current_player_builder_sequence > S->deferred_builder_sequence) {
      S->later_builder_result_calls++;
    }
  }
  if (g_injecting || !g_ready || target_logic != g_player_logic) {
    return g_projectile_original(projectile_logic, target_logic, arg2, arg3);
  }
  health_note_source(2,projectile_logic,read_u32(projectile_logic,PROJECTILE_RUNTIME_ID),0);
  token = find_projectile_target(
    projectile_logic, g_player_actor,
    read_u32(projectile_logic, PROJECTILE_RUNTIME_ID)
  );
  if (token == 0 || token->state != PROJECTILE_RELEASED ||
      S->ranged_wait_evade != g_owned_evade ||
      S->ranged_wait_runtime != g_owned_runtime) {
    if (token != 0 && token->state == PROJECTILE_WAITING) {
      S->blocked_projectile_leases++;
    }
    return g_projectile_original(projectile_logic, target_logic, arg2, arg3);
  }
  lease = begin_lease();
  result = g_projectile_original(projectile_logic, target_logic, arg2, arg3);
  end_lease(lease);
  token->state = PROJECTILE_SETTLED;
  S->ranged_wait_evade = 0;
  S->ranged_wait_runtime = 0;
  S->released_result_calls++;
  health_note_source(2,projectile_logic,read_u32(projectile_logic,PROJECTILE_RUNTIME_ID),result);
  return result;
}

void projectile_eligibility_on_enter(GumInvocationContext *ic) {
  struct projectile_gate_slot *slot;
  u32 thread_id;
  if (!g_ready || g_injecting ||
      gum_invocation_context_get_return_address(ic) !=
        g_projectile_eligibility_gate_caller_return) return;
  thread_id = GetCurrentThreadId();
  slot = get_projectile_gate_slot(thread_id);
  if (!slot->active || slot->thread_id != thread_id ||
      slot->generation != g_generation || slot->target_logic != g_player_logic) {
    return;
  }
}

void projectile_eligibility_on_leave(GumInvocationContext *ic) {
  struct projectile_gate_slot *slot;
  u32 thread_id;
  if (!g_ready || g_injecting ||
      gum_invocation_context_get_return_address(ic) !=
        g_projectile_eligibility_gate_caller_return) return;
  thread_id = GetCurrentThreadId();
  slot = get_projectile_gate_slot(thread_id);
  if (!slot->active || slot->thread_id != thread_id ||
      slot->generation != g_generation || slot->target_logic != g_player_logic ||
      slot->projectile == 0) return;
  if ((u64)gum_invocation_context_get_return_value(ic) == 0) return;
  if (handle_projectile_eligibility_true(slot)) {
    gum_invocation_context_replace_return_value(ic, 0);
  }
}

void melee_pair_on_enter(GumInvocationContext *ic) {
  struct melee_pair_slot *slot;
  void *target_group;
  u32 thread_id;
  if (!g_ready || g_injecting ||
      gum_invocation_context_get_return_address(ic) != g_melee_pair_caller_return) {
    return;
  }
  target_group = gum_invocation_context_get_nth_argument(ic, 1);
  if (target_group == 0 || target_group != g_player_collision_group) return;
  thread_id = GetCurrentThreadId();
  slot = &S->melee_pair_slots[thread_id % FILTER_THREAD_SLOTS];
  slot->thread_id = thread_id;
  slot->active = 1;
  slot->target_group = target_group;
  slot->generation = g_generation;
  slot->attempted = 0;
  slot->installed = 0;
}

void melee_pair_on_leave(GumInvocationContext *ic) {
  struct melee_pair_slot *slot;
  u32 thread_id = GetCurrentThreadId();
  slot = &S->melee_pair_slots[thread_id % FILTER_THREAD_SLOTS];
  if (!slot->active || slot->thread_id != thread_id ||
      slot->generation != g_generation ||
      slot->target_group != g_player_collision_group) return;
  slot->active = 0;
  if ((u64)gum_invocation_context_get_return_value(ic) == 0) return;
  S->melee_pair_true_seen++;
  if (has_owned_active()) return;
  slot->attempted = 1;
  S->melee_pair_requests++;
  if (request_evade_native(0)) {
    slot->installed = 1;
    S->melee_pair_installed++;
  }
}


// Build 24463856: BCC040 owns the actual area target transaction. BCB540
// returns ActorLogic pointers before BCC040's native Just/child application.
// Never edit its target array, Effect age, Skill timers or damage result.
struct effect_scope {
  struct effect_scope *previous;
  void *effect, *row, *children, *player, *owned;
  u64 sequence;
  u32 thread, generation, runtime, linked, eligible, matched, attempted;
};
struct effect_slot { struct effect_scope *current; u32 thread; };
struct effect_state {
  struct effect_slot slots[64];
  void *gather_return, *just_return;
  void *data_manager, *alias_lookup;
  u32 enabled;
  u64 stats[24];
};
struct effect_gather_probe { struct effect_scope *scope; void *targets; };
struct effect_just_probe { struct effect_scope *scope; void *skill; u32 runtime; };
#define ES ((struct effect_state *)S->effect_state)
u32 effect_state_size(void) { return sizeof(struct effect_state); }
void configure_effect_response(void *state, void *gather_return, void *just_return, u32 enabled) {
  S->effect_state=state;
  if(!ES)return;
  ES->gather_return=gather_return; ES->just_return=just_return; ES->enabled=enabled;
}
void configure_effect_lookup(void *data_manager,void *alias_lookup) {
  if(!ES)return;
  ES->data_manager=data_manager; ES->alias_lookup=alias_lookup;
}
void read_effect_response_stats(u64 *out) { u32 i; for(i=0;i<24;i++)out[i]=ES?ES->stats[i]:0; }
static struct effect_scope *effect_current(u32 thread) {
  struct effect_slot *slot;
  if(!ES)return 0;
  slot=&ES->slots[thread%64];
  return slot->thread==thread?slot->current:0;
}
static int effect_scope_valid(struct effect_scope *scope) {
  return ES && ES->enabled && g_ready && !g_injecting && scope && scope->linked &&
    scope->generation==g_generation && scope->player==g_player_logic && g_player_logic;
}
// Current-build native HP damage formula: StatType=HP, StatCalculationType=9,
// negative CalculationValue. No boss IDs, presentation flags or distance guesses.
static int effect_hp_damage_row(void *row) {
  float value;
  if(!row || read_u8(row,8)!=1 || read_u8(row,0x164)!=1 || read_u8(row,0x170)!=9)return 0;
  value=read_f32(row,0x174);
  return finite_input_float(value) && value<0.0f;
}
typedef void *(*effect_alias_lookup_t)(void*,void*,u64);
typedef void (*effect_row_init_t)(void*);
static int effect_children_handle_just(void *children) {
  void *manager,*registry,*row,*vtable,*initialize;
  u64 *aliases; u32 count,i,damage=0;
  if(!ES->data_manager || !ES->alias_lookup)return 0;
  count=read_u32(children,8); aliases=read_pointer(children,0);
  manager=((logic_manager_host_t)ES->data_manager)();
  registry=manager?read_pointer(manager,0x20):0;
  if(!registry){ES->stats[22]++;return 0;}
  // Exactly the FName value ABI at BCC8F1 -> A9EA70, followed by the same
  // native lazy row initialization as BCC905..BCC919. Combat properties stay native.
  for(i=0;i<count;i++) {
    row=((effect_alias_lookup_t)ES->alias_lookup)(registry,0,aliases[i]);
    if(!row){ES->stats[22]++;return 0;}
    if(read_u8(row,8)==0) {
      vtable=read_pointer(row,0); initialize=vtable?read_pointer(vtable,0x20):0;
      if(!initialize){ES->stats[22]++;return 0;}
      write_u8(row,8,1); ((effect_row_init_t)initialize)(row);
    }
    if(read_u8(row,8)!=1){ES->stats[22]++;return 0;}
    if(effect_hp_damage_row(row)) {
      if(read_u8(row,0x249)!=1)return 0;
      damage++;
    } else if(read_u8(row,0x164)!=0) {
      // A mixed/unknown stat transaction retains the established parent route.
      return 0;
    }
  }
  return damage>0;
}
static void effect_begin(struct effect_scope *scope, void *effect, void *row,
    void *children, u32 thread) {
  struct effect_slot *slot;
  scope->linked=0; scope->eligible=0; scope->matched=0; scope->attempted=0;
  scope->owned=0; scope->runtime=0; scope->sequence=0;
  if(!ES || !ES->enabled || !g_ready || g_injecting)return;
  slot=&ES->slots[thread%64];
  if(slot->current && slot->thread!=thread){ES->stats[11]++;return;}
  scope->previous=slot->current; scope->thread=thread; scope->generation=g_generation;
  scope->player=g_player_logic; scope->effect=effect; scope->row=row; scope->children=children;
  scope->linked=1; slot->thread=thread; slot->current=scope; ES->stats[0]++;
  if(!effect || !row || read_u8(row,8)!=1 ||
      read_u32(effect,0x104)!=read_u32(row,0x10) || read_u8(row,0x249)!=1)return;
  if(effect_hp_damage_row(row)) {
    // The damage child is independently targeted. Request only after its own
    // gather, immediately before BCC040's real Just gate and HP calculation.
    // A leaf does not need ground-placement or further child effects.
    ES->stats[20]++;
  } else {
    if(read_u8(row,0x43a)!=1 || !children || !read_pointer(children,0) ||
        !read_u32(children,8) || read_u32(children,8)>read_u32(children,12) ||
        read_u32(children,8)>64)return;
    if(effect_children_handle_just(children)) {
      ES->stats[21]++;return;
    }
  }
  scope->eligible=1; scope->sequence=++ES->stats[1];
}
static void effect_end(struct effect_scope *scope) {
  struct effect_slot *slot;
  if(!ES || !scope || !scope->linked)return;
  slot=&ES->slots[scope->thread%64];
  if(slot->thread==scope->thread && slot->current==scope)slot->current=scope->previous;
  else ES->stats[11]++;
  scope->linked=0;
}
static void *effect_current_evade(void) {
  void *manager,*skill,*row; u32 runtime;
  if(!g_logic_manager_host || !g_active_resolver || !g_player_logic)return 0;
  runtime=read_u32(g_player_logic,LOGIC_RUNTIME_ID); if(!runtime)return 0;
  manager=((logic_manager_host_t)g_logic_manager_host)(); if(!manager)return 0;
  skill=((active_resolver_t)g_active_resolver)(manager,runtime);
  if(!skill || read_pointer(skill,0x68)!=g_player_logic || read_u8(skill,SKILL_ACTIVE)!=1)return 0;
  row=read_pointer(skill,0x58);
  return row && read_u8(row,0x75)==4 && read_f32(skill,SKILL_PERFECT_WINDOW)>0.0f?skill:0;
}
static void effect_gather_returned(struct effect_scope *scope, void *targets) {
  void **data; void *source,*previous; u32 count,i; u64 attempts;
  if(!effect_scope_valid(scope) || !scope->eligible || scope->attempted ||
      effect_current(scope->thread)!=scope || !targets)return;
  ES->stats[2]++;
  count=read_u32(targets,8); data=read_pointer(targets,0);
  if(!data || !count || count>1024 || count>read_u32(targets,12))return;
  for(i=0;i<count;i++)if(data[i]==g_player_logic)break;
  if(i==count)return;
  scope->matched=1; scope->attempted=1; ES->stats[3]++;
  health_note_source(3,scope->effect,read_u32(scope->row,0x10),0);
  ES->stats[12]=read_u32(scope->row,0x10); ES->stats[13]=scope->sequence;
  ES->stats[14]=read_u32(scope->effect,0x110);
  void *active_evade=effect_current_evade();
  if(active_evade) {
    if(active_evade==g_owned_evade && g_owned_runtime==read_u32(g_player_logic,LOGIC_RUNTIME_ID)) {
      scope->owned=active_evade; scope->runtime=g_owned_runtime;
    }
    ES->stats[4]++; return;
  }
  // request_evade_native allows replacement, so admission explicitly preserves
  // an existing trainer-owned action (including Guard waiting for its scheduler).
  if(guard_owned_pending()) { ES->stats[5]++; return; }
  if(has_owned_active()) {
    struct repeat_phase phase;
    if(!capture_repeat_phase(&phase) || !phase.repeat_eligible) { ES->stats[5]++; return; }
    // A new native pulse may request the next Evade only after the current
    // Step opens its native repeat gate. Never stop/restart the old action.
  }
  // Effect source +0x60 is the ActorLogic used by BCB540 and BFBC30;
  // ActorLogic+0x60 points to the live actor, just as the existing input route.
  source=read_pointer(scope->effect,0x60);
  if(!source || source==g_player_logic || !read_pointer(source,0x60)) { ES->stats[6]++; return; }
  previous=S->request_source_actor; S->request_source_actor=source;
  attempts=S->attempts;
  if(request_evade_native(0)) {
    scope->owned=g_owned_evade; scope->runtime=g_owned_runtime; ES->stats[8]++;
    ES->stats[15]=scope->runtime;
    ES->stats[16]=read_u32(scope->owned,SKILL_PERFECT_WINDOW);
    ES->stats[17]=read_u32(scope->owned,0xbc);
  }
  S->request_source_actor=previous;
  if(S->attempts!=attempts)ES->stats[7]++;
  else ES->stats[9]++;
}
void effect_apply_on_enter(GumInvocationContext *ic) {
  struct effect_scope *scope=gum_invocation_context_get_listener_invocation_data(ic,sizeof(struct effect_scope));
  effect_begin(scope,gum_invocation_context_get_nth_argument(ic,0),
    gum_invocation_context_get_nth_argument(ic,1),gum_invocation_context_get_nth_argument(ic,3),GetCurrentThreadId());
}
void effect_apply_on_leave(GumInvocationContext *ic) {
  effect_end(gum_invocation_context_get_listener_invocation_data(ic,sizeof(struct effect_scope)));
}
void effect_gather_on_enter(GumInvocationContext *ic) {
  struct effect_gather_probe *probe=gum_invocation_context_get_listener_invocation_data(ic,sizeof(struct effect_gather_probe));
  struct effect_scope *scope=effect_current(GetCurrentThreadId());
  probe->scope=0; probe->targets=0;
  if(!effect_scope_valid(scope) || !scope->eligible ||
      gum_invocation_context_get_return_address(ic)!=ES->gather_return ||
      gum_invocation_context_get_nth_argument(ic,0)!=scope->effect)return;
  probe->scope=scope; probe->targets=gum_invocation_context_get_nth_argument(ic,2);
}
void effect_gather_on_leave(GumInvocationContext *ic) {
  struct effect_gather_probe *probe=gum_invocation_context_get_listener_invocation_data(ic,sizeof(struct effect_gather_probe));
  effect_gather_returned(probe->scope,probe->targets);
}
void effect_just_on_enter(GumInvocationContext *ic) {
  struct effect_just_probe *probe=gum_invocation_context_get_listener_invocation_data(ic,sizeof(struct effect_just_probe));
  struct effect_scope *scope=effect_current(GetCurrentThreadId()); void *skill; u32 depth=0;
  probe->scope=0;
  if(!effect_scope_valid(scope) || gum_invocation_context_get_return_address(ic)!=ES->just_return)return;
  skill=gum_invocation_context_get_nth_argument(ic,0);
  if(!skill || read_pointer(skill,0x68)!=g_player_logic)return;
  // A fresh child Effect may consume the Evade requested by its parent area.
  // Link only within this actual native stack; never use a global last event.
  while(scope && depth++<16) {
    if(effect_scope_valid(scope) && scope->matched && scope->owned==skill &&
        scope->runtime && scope->runtime==read_u32(g_player_logic,LOGIC_RUNTIME_ID)) {
      probe->scope=scope; probe->skill=skill; probe->runtime=scope->runtime; ES->stats[10]++;return;
    }
    scope=scope->previous;
  }
}
void effect_just_on_leave(GumInvocationContext *ic) {
  struct effect_just_probe *probe=gum_invocation_context_get_listener_invocation_data(ic,sizeof(struct effect_just_probe));
  u64 result=(u64)gum_invocation_context_get_return_value(ic);
  if(!effect_scope_valid(probe->scope))return;
  ES->stats[18]=result;
  if(result==1)ES->stats[19]++;
}


// Passive Build24463856 HP diagnostics. Actor+11c/+120 are confirmed by
// A64CE0, the existing CT/B1 chain, and the current self-player binding.
// This observer never changes an actor attribute or a native return value.
struct health_event { u64 v[28]; };
struct health_state {
  void *clock;
  u32 enabled,valid,generation;
  void *actor;
  float hp,maximum,lost;
  u64 next,drops,gains,invalid_reads,last_sample;
  u64 source_tick,source_kind,source_id,source_pointer,source_result;
  struct health_event rows[64];
};
struct health_invocation { void *actor,*context,*caller;u32 generation,selector,active; };
#define HS ((struct health_state *)S->health_state)
u32 health_state_size(void){return sizeof(struct health_state);}
u32 health_event_size(void){return sizeof(struct health_event);}
void configure_health_trace(void *state,void *clock,u32 enabled){
  S->health_state=state;if(!HS)return;HS->clock=clock;HS->enabled=enabled;
}
static u64 health_now(void){return HS&&HS->clock?((special_clock_t)HS->clock)():0;}
static void health_observe(void *actor,u32 cause,void *caller,void *context,u32 selector,u32 phase);
static void health_note_source(u32 kind,void *source,u32 id,u32 result){
  if(!HS || !HS->enabled || !g_ready)return;
  health_observe(g_player_actor,1,0,0,0,0);
  HS->source_tick=health_now();HS->source_kind=kind;HS->source_id=id;
  HS->source_pointer=(u64)source;HS->source_result=result;
}
static void health_emit(float before,float after,float max_before,float max_after,
    u32 kind,u32 cause,void *caller,void *context,u32 selector,u32 phase){
  struct health_event *e;struct effect_scope *effect;
  struct melee_call_context *melee;struct repeat_phase player;
  u64 serial;u32 i,thread=GetCurrentThreadId();
  if(!HS)return;
  serial=HS->next+1;e=&HS->rows[(serial-1)%64];
  for(i=0;i<28;i++)e->v[i]=0;
  e->v[1]=health_now();e->v[2]=g_generation;e->v[3]=kind;
  e->v[4]=init_float_bits(before);e->v[5]=init_float_bits(after);
  e->v[6]=init_float_bits(max_before);e->v[7]=init_float_bits(max_after);
  e->v[8]=cause;e->v[9]=(u64)caller;e->v[10]=(u64)context;e->v[11]=selector;
  e->v[12]=g_player_logic?read_u32(g_player_logic,LOGIC_RUNTIME_ID):0;
  e->v[13]=g_owned_runtime;e->v[14]=S->attempts;e->v[15]=S->installed;
  e->v[16]=S->rejected;e->v[17]=IT?IT->next:0;
  e->v[18]=HS->source_kind;e->v[19]=HS->source_id;
  e->v[20]=HS->source_pointer;e->v[21]=HS->source_tick;
  e->v[22]=HS->source_result;e->v[23]=HS->source_kind?2:0;
  effect=effect_current(thread);
  melee=&S->melee_call_contexts[thread%FILTER_THREAD_SLOTS];
  if(effect && effect->linked && effect->generation==g_generation && effect->player==g_player_logic){
    e->v[18]=3;e->v[19]=read_u32(effect->row,0x10);e->v[20]=(u64)effect->effect;
    e->v[21]=e->v[1];e->v[22]=0;e->v[23]=1;
    if(effect->previous && effect->previous->generation==g_generation)
      e->v[26]=read_u32(effect->previous->row,0x10);
  }else if(melee->active && melee->thread_id==thread && melee->generation==g_generation && melee->target==g_player_logic){
    e->v[18]=1;e->v[19]=read_u32(melee->step,STEP_ID);e->v[20]=(u64)melee->source;
    e->v[21]=e->v[1];e->v[22]=0;e->v[23]=1;
  }
  if(capture_repeat_phase(&player)){
    e->v[24]=read_u32(read_pointer(player.active_skill,0x58),0x10);
    e->v[25]=read_u32(player.step,STEP_ID);
  }
  e->v[27]=phase;
  // The serial is the commit marker for the cold telemetry reader.
  *((volatile u64*)&e->v[0])=serial;HS->next=serial;
}
static void health_observe(void *actor,u32 cause,void *caller,void *context,u32 selector,u32 phase){
  float hp,maximum;u64 now;
  if(!HS || !HS->enabled || !g_ready || !actor || actor!=g_player_actor)return;
  if(read_u8(actor,0x49a)!=1)return;
  now=health_now();
  if(cause==1 && HS->valid && HS->generation==g_generation && HS->actor==actor && now-HS->last_sample<16)return;
  HS->last_sample=now;hp=read_f32(actor,0x11c);maximum=read_f32(actor,0x120);
  if(!finite_input_float(hp) || !finite_input_float(maximum) || hp<0.0f || maximum<=0.0f){HS->invalid_reads++;return;}
  if(!HS->valid || HS->generation!=g_generation || HS->actor!=actor){
    HS->valid=1;HS->generation=g_generation;HS->actor=actor;HS->hp=hp;HS->maximum=maximum;
    HS->source_kind=0;HS->source_id=0;HS->source_pointer=0;HS->source_tick=0;HS->source_result=0;
    health_emit(hp,hp,maximum,maximum,0,cause,caller,context,selector,phase);return;
  }
  if(hp!=HS->hp || maximum!=HS->maximum){
    u32 kind=hp<HS->hp?1:(hp>HS->hp?2:3);
    if(kind==1){HS->drops++;HS->lost+=HS->hp-hp;}
    if(kind==2)HS->gains++;
    health_emit(HS->hp,hp,HS->maximum,maximum,kind,cause,caller,context,selector,phase);
    HS->hp=hp;HS->maximum=maximum;
  }
}
static void health_sample_player(void *skill){
  void *logic;
  if(!HS || !HS->enabled || !g_ready || g_injecting || !skill)return;
  logic=read_pointer(skill,0x68);
  if(logic!=g_player_logic || read_pointer(logic,0x60)!=g_player_actor)return;
  health_observe(g_player_actor,1,0,0,0,0);
}
void health_mutation_on_enter(GumInvocationContext *ic){
  struct health_invocation *p=gum_invocation_context_get_listener_invocation_data(ic,sizeof(struct health_invocation));
  p->active=0;
  if(!HS || !HS->enabled || !g_ready)return;
  p->actor=gum_invocation_context_get_nth_argument(ic,0);
  p->selector=(u32)(u64)gum_invocation_context_get_nth_argument(ic,1);
  if(p->actor!=g_player_actor || (p->selector!=1 && p->selector!=2))return;
  p->generation=g_generation;p->context=gum_invocation_context_get_nth_argument(ic,2);
  p->caller=gum_invocation_context_get_return_address(ic);p->active=1;
  health_observe(p->actor,2,p->caller,p->context,p->selector,1);
}
void health_mutation_on_leave(GumInvocationContext *ic){
  struct health_invocation *p=gum_invocation_context_get_listener_invocation_data(ic,sizeof(struct health_invocation));
  if(!p->active || p->generation!=g_generation || p->actor!=g_player_actor)return;
  health_observe(p->actor,2,p->caller,p->context,p->selector,2);
}
u32 read_health_trace(u64 *meta,struct health_event *out){
  u32 i,j,n=0;u64 serial;
  for(i=0;i<10;i++)meta[i]=0;
  if(!HS)return 0;
  meta[0]=HS->enabled;meta[1]=HS->valid && g_ready && HS->generation==g_generation && HS->actor==g_player_actor;meta[2]=init_float_bits(HS->hp);
  meta[3]=init_float_bits(HS->maximum);meta[4]=HS->generation;meta[5]=HS->next;
  meta[6]=HS->drops;meta[7]=HS->gains;meta[8]=HS->invalid_reads;meta[9]=init_float_bits(HS->lost);
  for(i=0;i<64;i++){
    serial=*((volatile u64*)&HS->rows[i].v[0]);if(!serial)continue;
    for(j=0;j<28;j++)out[n].v[j]=HS->rows[i].v[j];
    if(serial==*((volatile u64*)&HS->rows[i].v[0]) && out[n].v[0]==serial)n++;
  }
  return n;
}

void configure(
    void *player_actor,
    void *player_logic,
    void *actor_manager,
    void *player_collision_group,
    struct action_candidate *action_candidates,
    u32 action_candidate_count,
    void *use_skill,
    void *update_skill,
    void *deactivate_skill,
    void *select_command_node,
    void *find_actor,
    void *filtered_actor_caller_return,
    void *projectile_eligibility_gate_caller_return,
    void *melee_pair_caller_return,
    u32 generation) {
  u32 i;
  g_ready = 0;
  S->guard_draining=0;
  g_player_actor = player_actor;
  g_player_logic = player_logic;
  g_actor_manager = actor_manager;
  g_player_collision_group = player_collision_group;
  reset_action_candidates();
  if (action_candidates != 0 && action_candidate_count <= ACTION_CANDIDATE_CAPACITY) {
    for (i = 0; i != action_candidate_count; i++) {
      g_action_candidates[i] = action_candidates[i];
    }
    g_action_candidate_count = action_candidate_count;
  }
  S->use_skill = use_skill;
  S->update_skill = update_skill;
  S->deactivate_skill = deactivate_skill;
  S->select_command_node = select_command_node;
  S->find_actor = find_actor;
  g_filtered_actor_caller_return = filtered_actor_caller_return;
  g_projectile_eligibility_gate_caller_return = projectile_eligibility_gate_caller_return;
  g_melee_pair_caller_return = melee_pair_caller_return;
  g_generation = generation;
  special_reset_binding();
  g_injecting = 0;
  reset_owned();
  reset_tokens();
  g_ready = (
    g_player_actor != 0 && g_player_logic != 0 && g_actor_manager != 0 &&
    g_player_collision_group != 0 && g_melee_pair_caller_return != 0 &&
    g_use_skill != 0 && g_update_skill != 0 && g_deactivate_skill != 0 &&
    g_select_command_node != 0 &&
    g_find_actor != 0 && g_projectile_eligibility_gate_caller_return != 0
  );
}

void set_probe_addresses(void *angle_site, void *just_consumer, void *just_return) {
  g_angle_probe_site = angle_site;
  g_just_consumer = just_consumer;
  g_just_consumer_return = just_return;
}

void set_dodge_disabled(u32 disabled){S->dodge_disabled=disabled!=0;}

void disable(void) {
  g_ready = 0;
  S->special_enabled=0;
  special_clear_ownership();
}

void clear_state(void) {
  g_ready = 0;
  g_generation = 0;
  g_player_actor = 0;
  g_player_logic = 0;
  g_actor_manager = 0;
  g_player_collision_group = 0;
  reset_action_candidates();
  S->use_skill = 0;
  S->update_skill = 0;
  S->deactivate_skill = 0;
  S->select_command_node = 0;
  S->find_actor = 0;
  g_logic_manager_host = 0;
  g_active_resolver = 0;
  S->request_source_actor = 0;
  S->movement_scope = 0;
  S->initialization_active_record = 0;
  S->guard_request_active = 0;
  g_filtered_actor_caller_return = 0;
  g_projectile_eligibility_gate_caller_return = 0;
  g_melee_pair_caller_return = 0;
  g_melee_source_gate_caller_return = 0;
  g_angle_probe_site = 0;
  g_just_consumer = 0;
  g_just_consumer_return = 0;
  g_injecting = 0;
  reset_owned();
  reset_tokens();
  S->special_enabled=0;S->special_allowed=0;
  special_clear_ownership();
}

void read_stats(u64 *out) {
  out[0] = S->attempts;
  out[1] = S->installed;
  out[2] = S->rejected;
  out[3] = S->melee_calls;
  out[4] = S->hit_builder_calls;
  out[5] = S->player_matches;
  out[6] = S->action_claims;
  out[7] = S->projectile_calls;
  out[8] = S->deferred_hits;
  out[9] = S->retry_hits;
  out[10] = S->same_builder_result_calls;
  out[11] = S->later_builder_result_calls;
  out[12] = S->primary_num_at_defer;
  out[13] = S->secondary_num_at_defer;
  out[14] = S->owned_natural_updates;
  out[15] = S->waiting_defers;
  out[16] = S->released_after_update;
  out[17] = S->fail_open_releases;
  out[18] = S->blocked_projectile_leases;
  out[19] = S->released_result_calls;
  out[20] = S->rearmed_attacks;
  out[21] = S->native_stops;
  out[22] = S->stop_confirmed;
  out[23] = S->stop_failed;
  out[24] = S->restart_attempts;
  out[25] = S->restart_installed;
  out[26] = S->restart_rejected;
  out[27] = S->gate_true_seen;
  out[28] = S->gate_suppressed;
  out[29] = S->same_projectile_gate_reentered;
  out[30] = S->released_original_true;
  out[31] = S->melee_pair_true_seen;
  out[32] = S->melee_pair_requests;
  out[33] = S->melee_pair_installed;
  out[34] = S->melee_pair_consumed;
  out[35] = S->selector_returned;
  out[36] = S->selector_fallback_used;
  out[37] = S->request_returned_nonnull;
  out[38] = S->request_returned_null;
  out[39] = S->runtime_changed;
  out[40] = S->pending_state;
  out[41] = S->forced_bfd340_issued;
  out[42] = S->active_state;
  out[43] = S->current_step_established;
  out[44] = S->old_owned_active;
  out[45] = S->natural_bfd340_seen;
  out[46] = S->pending_created;
  out[47] = S->pending_deferrals;
  out[48] = S->pending_rechecks;
  out[49] = S->installed_after_wait;
  out[50] = S->pending_invalidated;
}

u32 read_melee_diag(struct melee_diag *out, u32 capacity) {
  u32 i;
  u32 count = capacity < MELEE_DIAG_CAPACITY ? capacity : MELEE_DIAG_CAPACITY;
  if (out == 0) return 0;
  for (i = 0; i != count; i++) out[i] = g_melee_diag[i];
  return count;
}

void read_ranged_request_diag(struct melee_diag *out) {
  *out = S->ranged_request_diag;
}

u64 read_native_selector_deferred(void) { return S->native_selector_deferred; }

void configure_repeat_sources(void *logic_manager_host, void *active_resolver) {
  g_logic_manager_host = logic_manager_host;
  g_active_resolver = active_resolver;
}

void set_melee_source_gate_return(void *return_address) {
  g_melee_source_gate_caller_return = return_address;
}

u32 shared_state_size(void) { return sizeof(struct shared_state); }
`;

// Input-priority layer.  D2BDD0 only suppresses an eligible current-player
// command before it is queued.  BA23C0 is checked separately against the
// exact queue record recovered in R15; all unknown paths fail open.
const inputPrioritySource = String.raw`
#include <gum/guminterceptor.h>
typedef unsigned char u8;
typedef unsigned int u32;
typedef unsigned long long u64;
typedef void *(*use_skill_t)(void *,u32,void *,void *,u8,u8,u64,u8,void *,u8,void *,u8);
extern unsigned char shared_priority_state[];
extern void context_reader(u64 *);
extern void *use_skill_target_slot;
extern void *selector_return_slot;
extern void *use_skill_return_slot;
extern u32 GetCurrentThreadId(void);
struct pstate {
  volatile u64 selector_suppressed,selector_pass,queued_suppressed,queued_pass;
  volatile u64 selector_reason[8],queued_reason[8];
  volatile u32 enabled,stopped;
};
struct pctx { u64 v[12]; };
struct selector_frame { u64 actor,logic,manager,caller;u32 generation,input,thread,active; };
#define P ((struct pstate *)shared_priority_state)
static u64 rd(void *p,u32 o){return p?*(u64 *)((u8 *)p+o):0;}
static u32 rd32(void *p,u32 o){return p?*(u32 *)((u8 *)p+o):0;}
static u8 rd8(void *p,u32 o){return p?*(u8 *)((u8 *)p+o):0;}
static void ctx(struct pctx *c){context_reader(c->v);}
static int same_context(struct pctx *a,struct pctx *b){
  return a->v[0]&&b->v[0]&&a->v[1]==b->v[1]&&a->v[2]==b->v[2]&&a->v[3]==b->v[3];
}
static int owner_active(struct pctx *c){
  void *actor=(void *)c->v[2],*logic=(void *)c->v[3],*skill;u32 runtime;
  if(!c->v[0]||!actor||!logic||rd8(actor,0x49a)!=1||rd(logic,0x60)!=(u64)actor)return 0;
  runtime=rd32(logic,0x5d0);if(!runtime)return 0;
  if(c->v[6]&&runtime==(u32)c->v[7]){
    skill=(void *)c->v[6];
    if(rd8(skill,0xc0)==1&&rd(skill,0x68)==(u64)logic)return 1;
  }
  if(c->v[8]&&c->v[11]&&c->v[10]==c->v[1]&&runtime==(u32)c->v[9]){
    skill=(void *)c->v[8];
    if(rd8(skill,0xc0)==1&&rd(skill,0x68)==(u64)logic)return 1;
  }
  return 0;
}
// Physical light/heavy attacks (22/23) retain the native command buffer and
// cancel windows. Do not discard them for the lifetime of an automatic action.
static int input_ok(u32 input){return input==24||input==26;}
static int queue_record(void *record,void *logic){
  u64 begin=rd(logic,0xb38),p=(u64)record;u32 count=rd32(logic,0xb40),cap=rd32(logic,0xb44);
  if(!begin||!p||!count||count>128||cap<count||cap>128||p<begin)return 0;
  return p-begin<(u64)count*0x58&&((p-begin)%0x58)==0;
}
void priority_selector_on_enter(GumInvocationContext *ic){
  struct selector_frame *f=gum_invocation_context_get_listener_invocation_data(ic,sizeof(*f));struct pctx c;
  f->active=0;if(!P->enabled||P->stopped)return;
  ctx(&c);if(!c.v[0])return;
  f->actor=c.v[2];f->logic=c.v[3];f->generation=(u32)c.v[1];
  f->thread=GetCurrentThreadId();f->manager=(u64)gum_invocation_context_get_nth_argument(ic,0);
  f->input=(u32)(u64)gum_invocation_context_get_nth_argument(ic,1);
  f->caller=(u64)gum_invocation_context_get_return_address(ic);f->active=1;
}
void priority_selector_on_leave(GumInvocationContext *ic){
  struct selector_frame *f=gum_invocation_context_get_listener_invocation_data(ic,sizeof(*f));
  struct pctx c,after;void *node;u32 reason=0;
  if(!f->active)return;f->active=0;node=gum_invocation_context_get_return_value(ic);ctx(&c);
  if(!P->enabled||P->stopped||!node||f->thread!=GetCurrentThreadId())goto pass;
  reason=1;if(!c.v[0]||f->generation!=(u32)c.v[1]||f->actor!=c.v[2]||f->logic!=c.v[3])goto pass;
  reason=2;if(!selector_return_slot||f->caller!=(u64)selector_return_slot)goto pass;
  reason=3;if(f->manager!=rd((void *)c.v[2],0x530))goto pass;
  reason=4;if(!owner_active(&c))goto pass;
  reason=5;if(!input_ok(f->input))goto pass;
  reason=6;if(!rd(node,0x24))goto pass;
  ctx(&after);if(!same_context(&c,&after))goto pass;
  gum_invocation_context_replace_return_value(ic,0);P->selector_suppressed++;P->selector_reason[7]++;return;
pass:
  P->selector_pass++;P->selector_reason[reason]++;
}
void *priority_use_skill_wrapper(void *a0,u32 a1,void *a2,void *a3,u8 a4,u8 a5,u64 a6,u8 a7,void *a8,u8 a9,void *a10,u8 a11){
  struct pctx c,after;GumInvocationContext *ic;void *caller=0,*record=0,*logic,*node;u32 reason=0;
  ctx(&c);ic=gum_interceptor_get_current_invocation();
  if(ic){caller=gum_invocation_context_get_return_address(ic);record=(void *)(u64)ic->cpu_context->r15;}
  if(!P->enabled||P->stopped)goto pass;
  reason=1;if(!c.v[0])goto pass;
  reason=2;if(!use_skill_return_slot||caller!=use_skill_return_slot)goto pass;
  logic=(void *)c.v[3];reason=3;if(a0!=logic||!queue_record(record,logic))goto pass;
  reason=4;if(!owner_active(&c))goto pass;
  reason=5;if(!input_ok(rd32(record,0x2c))||rd(record,0x18)!=0)goto pass;
  node=(void *)rd(record,0x50);reason=6;
  if(!node||!a6||rd(node,0x24)!=a6||rd32(record,0x14)!=a1)goto pass;
  ctx(&after);if(!same_context(&c,&after))goto pass;
  P->queued_suppressed++;P->queued_reason[7]++;return 0;
pass:
  P->queued_pass++;P->queued_reason[reason]++;
  return ((use_skill_t)use_skill_target_slot)(a0,a1,a2,a3,a4,a5,a6,a7,a8,a9,a10,a11);
}
void priority_enable(void){P->enabled=1;P->stopped=0;}
void priority_disable(void){P->enabled=0;P->stopped=1;}
u32 priority_is_enabled(void){return P->enabled&&!P->stopped;}
void priority_read_stats(u64 *out){
  u32 i;out[0]=P->selector_suppressed;out[1]=P->selector_pass;out[2]=P->queued_suppressed;out[3]=P->queued_pass;
  for(i=0;i<8;i++){out[4+i]=P->selector_reason[i];out[12+i]=P->queued_reason[i];}
}
u32 priority_state_size(void){return sizeof(struct pstate);}
`;

// Includes the expanded per-Step diagnostics; verified against native sizeof.
const sharedState = Memory.alloc(NATIVE_STATE_CAPACITY);
sharedState.writeByteArray(new Uint8Array(NATIVE_STATE_CAPACITY));
const meleeOriginalSlot = Memory.alloc(Process.pointerSize);
const projectileOriginalSlot = Memory.alloc(Process.pointerSize);
const hitRecordsOriginalSlot = Memory.alloc(Process.pointerSize);
const updateOriginalSlot = Memory.alloc(Process.pointerSize);
meleeOriginalSlot.writePointer(NULL);
projectileOriginalSlot.writePointer(NULL);
hitRecordsOriginalSlot.writePointer(NULL);
updateOriginalSlot.writePointer(NULL);

const movementOriginalSlot=Memory.alloc(Process.pointerSize);movementOriginalSlot.writePointer(NULL);
const movementSelectOriginalSlot=Memory.alloc(Process.pointerSize);movementSelectOriginalSlot.writePointer(NULL);
const nativeModule = new CModule(nativeSource, {
  movement_original_slot:movementOriginalSlot,
  movement_select_original_slot:movementSelectOriginalSlot,
  shared_state: sharedState,
  melee_original_slot: meleeOriginalSlot,
  projectile_original_slot: projectileOriginalSlot,
  hit_records_original_slot: hitRecordsOriginalSlot,
  update_original_slot: updateOriginalSlot,
  GetCurrentThreadId: Module.getGlobalExportByName('GetCurrentThreadId'),
});
markStartup('native_compiled');

const inputPriorityState=Memory.alloc(4096);inputPriorityState.writeByteArray(new Uint8Array(4096));
const priorityUseSkillTargetSlot=Memory.alloc(Process.pointerSize);priorityUseSkillTargetSlot.writePointer(NULL);
const prioritySelectorReturnSlot=Memory.alloc(Process.pointerSize);prioritySelectorReturnSlot.writePointer(NULL);
const priorityUseSkillReturnSlot=Memory.alloc(Process.pointerSize);priorityUseSkillReturnSlot.writePointer(NULL);
const inputPriorityModule=new CModule(inputPrioritySource,{
  shared_priority_state:inputPriorityState,
  context_reader:nativeModule.read_priority_context,
  use_skill_target_slot:priorityUseSkillTargetSlot,
  selector_return_slot:prioritySelectorReturnSlot,
  use_skill_return_slot:priorityUseSkillReturnSlot,
  GetCurrentThreadId:Module.getGlobalExportByName('GetCurrentThreadId'),
});
const priorityStateSize=new NativeFunction(inputPriorityModule.priority_state_size,'uint32',[])();
if(priorityStateSize>4096)throw new Error('input priority state layout mismatch');
const priorityEnable=new NativeFunction(inputPriorityModule.priority_enable,'void',[]);
const priorityDisable=new NativeFunction(inputPriorityModule.priority_disable,'void',[]);
const priorityIsEnabled=new NativeFunction(inputPriorityModule.priority_is_enabled,'uint32',[]);
const priorityReadStats=new NativeFunction(inputPriorityModule.priority_read_stats,'void',['pointer']);
const priorityStatsBuffer=Memory.alloc(160);
let prioritySelectorListener=null;
let priorityUseSkillInstalled=false;

// Cold readout only. Existing v5 melee rows retain their 600-byte layout.
const initializationState=Memory.alloc(32768);
initializationState.writeByteArray(new Uint8Array(32768));
const initRecordSize=new NativeFunction(nativeModule.initialization_record_size,'uint32',[])();
const initStateSize=new NativeFunction(nativeModule.initialization_trace_size,'uint32',[])();
if(initRecordSize!==640 || initStateSize>32768)throw new Error('initialization trace layout mismatch');
new NativeFunction(nativeModule.configure_initialization_trace,'void',['pointer'])(initializationState);
const readInitTrace=new NativeFunction(nativeModule.read_initialization_trace,'uint32',['pointer']);
const initOutput=Memory.alloc(32*640);
function snapshotInitializationTrace(){
  const n=readInitTrace(initOutput),rows=[];
  const phases=['beforeRequest','afterRequest','afterForcedUpdate','beforeFirstNaturalUpdate','afterFirstNaturalUpdate','atMeleeAngle'];
  for(let i=0;i<n;i++){
    const p=initOutput.add(i*640),h=k=>p.add(k*8),u=k=>h(k).readU64().toString();
    const sequence=Number(u(0));if(!sequence)continue;
    const mask=Number(u(8));
    const row={sequence,generation:u(1),submitThread:u(2),nativeAttempt:u(3),skillId:u(4),commandKey:h(5).readPointer().toString(),source:h(6).readPointer().toString(),sourceStep:u(7),phaseMask:mask,forcedUpdates:u(9),naturalThread:u(10),naturalDelta:h(11).readFloat(),angleAL:u(12),forcedOrder:u(13),naturalOrder:u(14),angleOrder:u(15)};
    if(!(mask&4)){row.forcedUpdates=null;row.forcedOrder=null;}
    if(!(mask&8)){row.naturalThread=null;row.naturalDelta=null;row.naturalOrder=null;}
    if(!(mask&32)){row.angleAL=null;row.angleOrder=null;}
    for(let j=0;j<6;j++){
      if(!(mask&(1<<j))){row[phases[j]]=null;continue;}
      const a=p.add(128+j*80),q=k=>a.add(k*8);
      row[phases[j]]={runtime:q(0).readU64().toString(),skill:q(1).readPointer().toString(),step:q(2).readU64().toString(),state:q(3).readU64().toString(),window:q(4).readFloat(),pending:q(5).readU64().toString(),movementIdentity:q(6).readPointer().toString(),movement:[q(7).readFloat(),q(8).readFloat(),q(9).readFloat()]};
    }
    row.requestedDirection=[p.add(608).readFloat(),p.add(616).readFloat(),p.add(624).readFloat()];
    row.requestSourceActor=p.add(632).readPointer().toString();
    rows.push(row);
  }
  rows.sort((a,b)=>a.sequence-b.sequence);return rows;
}

const movementState=Memory.alloc(32768);movementState.writeByteArray(new Uint8Array(32768));
const movementRowSize=new NativeFunction(nativeModule.movement_trace_row_size,'uint32',[])();
const movementStateSize=new NativeFunction(nativeModule.movement_trace_state_size,'uint32',[])();
if(movementRowSize!==384 || movementStateSize>32768)throw new Error('movement trace layout mismatch');
new NativeFunction(nativeModule.configure_movement_trace,'void',['pointer'])(movementState);
const readMovementTrace=new NativeFunction(nativeModule.read_movement_trace,'uint32',['pointer']);
const movementOutput=Memory.alloc(32*384);
function snapshotMovementTrace(){
  const n=readMovementTrace(movementOutput),rows=[];
  for(let i=0;i<n;i++){const p=movementOutput.add(i*384),h=k=>p.add(k*8),u=k=>h(k).readU64().toString();const sequence=Number(u(0));if(!sequence)continue;
    rows.push({sequence,generation:u(1),thread:u(2),initializationSequence:u(3),ba2e40Calls:u(4),be3bc0Calls:u(5),actor:h(6).readPointer().toString(),inputArg:h(7).readPointer().toString(),row:h(8).readPointer().toString(),selfPos:h(9).readPointer().toString(),gameInput:h(10).readPointer().toString(),direction:h(11).readPointer().toString(),outputMovement:h(12).readPointer().toString(),row60:u(13),row3a:u(14),row6c:u(15),row90:h(16).readFloat(),row94:h(17).readFloat(),row98:h(18).readFloat(),row9c:h(19).readFloat(),selfFront:[h(20).readFloat(),h(21).readFloat(),h(22).readFloat()],selfRight:[h(23).readFloat(),h(24).readFloat(),h(25).readFloat()],selfUp:[h(26).readFloat(),h(27).readFloat(),h(28).readFloat()],input:[h(29).readFloat(),h(30).readFloat(),h(31).readFloat()],directionValues:[h(32).readFloat(),h(33).readFloat(),h(34).readFloat()],output:[h(35).readFloat(),h(36).readFloat(),h(37).readFloat()],gameInputValues:[h(38).readFloat(),h(39).readFloat(),h(40).readFloat()],selfPosValues:[h(41).readFloat(),h(42).readFloat(),h(43).readFloat()],correctionState:u(44),effectiveDirection:[h(45).readFloat(),h(46).readFloat(),h(47).readFloat()]});}
  return rows.sort((a,b)=>a.sequence-b.sequence);
}
new NativeFunction(nativeModule.set_effective_input_policy,'void',['uint32'])(1);
const nativeGuardConfig=new NativeFunction(nativeModule.configure_guard_route,'void',['pointer','pointer','pointer','pointer','pointer','uint32']);
const nativeProjectileGuardConfig=new NativeFunction(nativeModule.configure_projectile_guard,'void',['pointer','pointer','pointer']);
const nativeProjectileGuardStats=new NativeFunction(nativeModule.read_projectile_guard_stats,'void',['pointer']);
const projectileGuardStatsBuffer=Memory.alloc(96);
function snapshotProjectileGuard(){nativeProjectileGuardStats(projectileGuardStatsBuffer);const k=['opportunities','contextUnavailable','sourceUnsupported','selectorUnavailable','rowUnavailable','actorStateRejected','positionUnavailable','nativeQueries','nativeGeometryRejected','selected','installed','refused'];const out={};k.forEach((name,i)=>out[name]=projectileGuardStatsBuffer.add(i*8).readU64().toString());return out;}
const nativeGuardStats=new NativeFunction(nativeModule.read_guard_route_stats,'void',['pointer']);
const nativeGuardDrain=new NativeFunction(nativeModule.begin_guard_drain,'void',[]);
const nativeGuardPending=new NativeFunction(nativeModule.guard_owned_pending,'uint32',[]);
const guardStatsBuffer=Memory.alloc(128);
function snapshotGuardRoute(){nativeGuardStats(guardStatsBuffer);const k=['opportunities','sourceUnsupported','selectorUnavailable','rowUnavailable','nativeQueries','nativeTargetRejected','selected','requests','installed','refused','releaseRequests','releaseConfirmed','dodgeRoutes','lastSourceStep','lastReason','unexpectedInitialStep'];const out={};k.forEach((name,i)=>out[name]=guardStatsBuffer.add(i*8).readU64().toString());out.ownedPending=nativeGuardPending();return out;}
function configureNativeGuardRoute(){
  guardInitialStepListener=Interceptor.attach(nativeAddress('initialStepResolver'),{
    onEnter:nativeModule.guard_initial_step_enter,onLeave:nativeModule.guard_initial_step_leave,
  });
  nativeGuardConfig(...['dataManager','skillRowLookup','filterRowLookup','targetQuery','freeArray'].map(nativeAddress),globalThis.STELLAR_GUARD_DISABLED===true||globalThis.STELLAR_OBSERVE_ONLY===true?0:1);
}
function configureNativeProjectileGuard(){
  nativeProjectileGuardConfig(nativeAddress('projectileRowLookup'),nativeAddress('projectileGeometry'),nativeSite('projectileStateCall').target);
}

const nativeDirectionPolicy=new NativeFunction(nativeModule.set_source_direction_policy,'void',['uint32']);
const nativeDirectionStats=new NativeFunction(nativeModule.read_source_direction_stats,'void',['pointer']);
const directionStatsBuffer=Memory.alloc(32);
nativeDirectionPolicy(1);
function snapshotDirectionPolicy(){nativeDirectionStats(directionStatsBuffer);return {enabled:directionStatsBuffer.readU64().toString(),requests:directionStatsBuffer.add(8).readU64().toString(),unavailable:directionStatsBuffer.add(16).readU64().toString(),selectorQueries:directionStatsBuffer.add(24).readU64().toString()};}
const nativeConfigure = new NativeFunction(
  nativeModule.configure,
  'void',
  ['pointer', 'pointer', 'pointer', 'pointer', 'pointer', 'uint32', 'pointer', 'pointer', 'pointer', 'pointer', 'pointer', 'pointer', 'pointer', 'pointer', 'uint32']
);
const nativeConfigureRepeatSources = new NativeFunction(
  nativeModule.configure_repeat_sources, 'void', ['pointer', 'pointer']
);
const nativeSetMeleeSourceGateReturn = new NativeFunction(
  nativeModule.set_melee_source_gate_return, 'void', ['pointer']
);
const nativeSharedStateSize = new NativeFunction(nativeModule.shared_state_size, 'uint32', []);
if (nativeSharedStateSize() >= NATIVE_STATE_CAPACITY) throw new Error('native shared state exceeds 131072-byte bound');
const actionCandidateBuffer = Memory.alloc(MAX_ACTION_CANDIDATES * 16);
const guardCandidateBuffer = Memory.alloc(MAX_ACTION_CANDIDATES * 16);
const commandActionBuffer = Memory.alloc(32);
const nativeActionRowsConfig = new NativeFunction(nativeModule.configure_action_rows,'void',['pointer','pointer','pointer','pointer','pointer']);
const nativeReadCommandAction = new NativeFunction(nativeModule.read_command_action,'uint32',['pointer','uint32','pointer']);
const nativeQualifyActionId = new NativeFunction(nativeModule.qualify_action_id,'uint32',['uint32','uint32']);
const nativeGuardCandidatesConfig = new NativeFunction(nativeModule.configure_guard_candidates,'void',['pointer','uint32']);
const nativeExtendCandidates = new NativeFunction(nativeModule.extend_action_candidates,'uint32',['pointer','pointer','uint32','pointer','uint32','pointer','uint32']);

const nativeDisable = new NativeFunction(nativeModule.disable, 'void', []);
const nativeClearState = new NativeFunction(nativeModule.clear_state, 'void', []);
const nativeReadStats = new NativeFunction(nativeModule.read_stats, 'void', ['pointer']);
const nativeReadMeleeDiag = new NativeFunction(
  nativeModule.read_melee_diag, 'uint32', ['pointer', 'uint32']
);
const statsBuffer = Memory.alloc(408);
const meleeDiagRecordSize = 600;
const meleeDiagBuffer = Memory.alloc(MELEE_DIAG_CAPACITY * meleeDiagRecordSize);
const rangedRequestDiagBuffer = Memory.alloc(meleeDiagRecordSize);
const nativeReadRangedRequestDiag = new NativeFunction(
  nativeModule.read_ranged_request_diag, 'void', ['pointer']
);
const nativeReadSelectorDeferred = new NativeFunction(nativeModule.read_native_selector_deferred, 'uint64', []);
const nativeSetProbeAddresses = new NativeFunction(
  nativeModule.set_probe_addresses, 'void', ['pointer', 'pointer', 'pointer']
);


const nativeSpecialConfig=new NativeFunction(nativeModule.configure_special_response,'void',
  ['pointer','pointer','pointer','pointer','pointer','pointer','uint32']);
const nativeSpecialStats=new NativeFunction(nativeModule.read_special_response_stats,'void',['pointer']);
const specialStatsBuffer=Memory.alloc(19*8);
function snapshotSpecialResponses() {
  nativeSpecialStats(specialStatsBuffer);
  const u=i=>specialStatsBuffer.add(i*8).readU64().toString();
  return {enabled:u(14)==='1',generation:u(15),polls:u(0),selectorQueries:u(1),
    qualified:u(2),requests:u(3),returnedNull:u(4),blue:u(5),purple:u(6),
    active:u(7)==='1',trackedRuntime:u(8),lastSkill:u(9),
    lastKey:specialStatsBuffer.add(80).readPointer().toString(),
    target:specialStatsBuffer.add(88).readPointer().toString(),
    initialStep:u(12),latestStep:u(13),maxPollMs:u(16),totalPollMs:u(17),bindingChanged:u(18),
    meaning:'Blue/purple count submitted native special requests; complete motion and rewards require gameplay validation.'};
}


// Ground-area response shares the same action owner as melee/projectiles.
const effectState=Memory.alloc(16384); effectState.writeByteArray(new Uint8Array(16384));
if(new NativeFunction(nativeModule.effect_state_size,'uint32',[])()>16384)
  throw new Error('Effect response state exceeds allocation');
const effectStatsBuffer=Memory.alloc(24*8);
const effectReadStats=new NativeFunction(nativeModule.read_effect_response_stats,'void',['pointer']);
const effectConfigure=new NativeFunction(nativeModule.configure_effect_response,'void',['pointer','pointer','pointer','uint32']);
const effectLookupConfigure=new NativeFunction(nativeModule.configure_effect_lookup,'void',['pointer','pointer']);
let effectListeners=[];
function snapshotEffectResponses() {
  effectReadStats(effectStatsBuffer);
  const names=['applications','eligiblePulses','targetQueries','playerMatches','alreadyEvading',
    'ownedActionBusy','sourceUnavailable','requests','installed','notSubmitted','nativeConsumers',
    'contextConflicts','lastEffectId','lastPulse','lastAgeBits','lastRuntime','lastWindowBits',
    'lastInitialWindowBits','lastNativeResult','perfectDodgeResults','damageApplications',
    'deferredAreaApplications','childLookupUnavailable','reserved'];
  const out={};names.forEach((name,i)=>out[name]=effectStatsBuffer.add(i*8).readU64().toString());
  out.meaning='Actual native area target selection; requests/installation and native Perfect results are distinct. Motion and damage require gameplay validation.';
  return out;
}
function installEffectResponses(){
  effectConfigure(effectState,nativeSite('effectGatherCall').returnAddress,nativeSite('effectJustCall').returnAddress,
    globalThis.STELLAR_DODGE_DISABLED===true||globalThis.STELLAR_OBSERVE_ONLY===true?0:1);
  effectLookupConfigure(nativeAddress('dataManager'),nativeAddress('effectAliasLookup'));
  effectListeners.push(Interceptor.attach(nativeAddress('effectApply'),{onEnter:nativeModule.effect_apply_on_enter,onLeave:nativeModule.effect_apply_on_leave}));
  effectListeners.push(Interceptor.attach(nativeAddress('effectGather'),{onEnter:nativeModule.effect_gather_on_enter,onLeave:nativeModule.effect_gather_on_leave}));
  effectListeners.push(Interceptor.attach(nativeAddress('effectJust'),{onEnter:nativeModule.effect_just_on_enter,onLeave:nativeModule.effect_just_on_leave}));
}

function installInputPriority(){
  const use=resolvedProfile.functions.actorLogicUseSkill.address;
  prioritySelectorReturnSlot.writePointer(nativeSite('prioritySelectorCall').returnAddress);
  priorityUseSkillReturnSlot.writePointer(nativeSite('priorityUseCall').returnAddress);
  priorityUseSkillTargetSlot.writePointer(use);
  prioritySelectorListener=Interceptor.attach(resolvedProfile.functions.selectCommandNode.address,{onEnter:inputPriorityModule.priority_selector_on_enter,onLeave:inputPriorityModule.priority_selector_on_leave});
  Interceptor.replace(use,inputPriorityModule.priority_use_skill_wrapper);priorityUseSkillInstalled=true;priorityEnable();
}

function snapshotInputPriority(){
  priorityReadStats(priorityStatsBuffer);
  const u=i=>priorityStatsBuffer.add(i*8).readU64().toString();
  return {enabled:priorityIsEnabled()===1,selectorSuppressed:u(0),selectorPass:u(1),queuedSuppressed:u(2),queuedPass:u(3),selectorReasons:Array.from({length:8},(_,i)=>u(4+i)),queuedReasons:Array.from({length:8},(_,i)=>u(12+i)),meaning:'Only manual dodge/guard can be protected during an owned response; light/heavy attacks always pass to native selection and buffering.'};
}


const healthState=Memory.alloc(32768);healthState.writeByteArray(new Uint8Array(32768));
const healthEventBytes=new NativeFunction(nativeModule.health_event_size,'uint32',[])();
if(healthEventBytes!==224 || new NativeFunction(nativeModule.health_state_size,'uint32',[])()>32768)
  throw new Error('Health trace layout mismatch');
const healthMeta=Memory.alloc(80),healthEvents=Memory.alloc(64*healthEventBytes);
const healthRead=new NativeFunction(nativeModule.read_health_trace,'uint32',['pointer','pointer']);
let healthListener=null;
let guardInitialStepListener=null;
function snapshotHealthTrace(){
  const n=healthRead(healthMeta,healthEvents),u=i=>healthMeta.add(i*8).readU64().toString();
  const events=[];
  for(let i=0;i<n;i++){
    const p=healthEvents.add(i*224),v=j=>p.add(j*8).readU64().toString(),f=j=>p.add(j*8).readFloat();
    events.push({serial:v(0),tickMs:v(1),generation:v(2),kind:['baseline','hp_drop','hp_gain','max_hp_change'][Number(v(3))],
      before:f(4),after:f(5),delta:f(5)-f(4),maxBefore:f(6),maxAfter:f(7),
      capture:Number(v(8))===2?'native_attribute':'player_update',caller:p.add(72).readPointer().toString(),
      mutationContext:p.add(80).readPointer().toString(),selector:v(11),playerRuntime:v(12),ownedRuntime:v(13),
      nativeAttempts:v(14),nativeInstalled:v(15),nativeRejected:v(16),initializationSequence:v(17),
      sourceKind:['none','melee','projectile','effect'][Number(v(18))]||'unknown',sourceId:v(19),
      source:p.add(160).readPointer().toString(),sourceTickMs:v(21),nativeDefenseResult:v(22),
      association:['none','same_native_scope','preceding_defense_event'][Number(v(23))],
      currentSkill:v(24),currentStep:v(25),parentEffectId:v(26),mutationPhase:v(27)});
  }
  events.sort((a,b)=>Number(BigInt(a.serial)-BigInt(b.serial)));
  return {enabled:u(0)==='1',valid:u(1)==='1',currentHp:healthMeta.add(16).readFloat(),maxHp:healthMeta.add(24).readFloat(),
    generation:u(4),serial:u(5),drops:u(6),gains:u(7),invalidReads:u(8),totalLost:healthMeta.add(72).readFloat(),
    capacity:64,dropped:(BigInt(u(5))>64n?BigInt(u(5))-64n:0n).toString(),events,
    meaning:'Actual player HP changes. Same-scope provenance is direct; preceding defense events are temporal context, not proof of the damage source.'};
}
function installHealthTrace(){
  new NativeFunction(nativeModule.configure_health_trace,'void',['pointer','pointer','uint32'])(healthState,Module.getGlobalExportByName('GetTickCount64'),1);
  healthListener=Interceptor.attach(nativeAddress('healthMutation'),{onEnter:nativeModule.health_mutation_on_enter,onLeave:nativeModule.health_mutation_on_leave});
}

let meleeInstalled = false;
let projectileInstalled = false;
let hitRecordsInstalled = false;
let updateInstalled = false;
let filteredActorListener = null;
let projectileEligibilityGateListener = null;
let meleePairListener = null;
let meleeSourceGateListener = null;
let angleProbeListener = null;
let justConsumerListener = null;
let justResolutionListener = null;
let movementInputSite=null;
let movementSelectionSite=null;
let probeAddresses = null;
let stopped = false;
let actionTrace = null;
function startActionTrace(){
  if(globalThis.STELLAR_DIAGNOSTICS===false)return;
  if(typeof StellarActionTrace==='undefined')throw new Error('missing native action trace module');
  const active=nativeSite('useActiveResolverCall'),row=nativeSite('useRequestedRowCall'),gate=nativeSite('useCommandGateCall'),restriction=nativeSite('useActorRestrictionCall');
  actionTrace=StellarActionTrace.create(resolvedProfile,nativeModule.read_action_trace_context,{
    manualRequests:globalThis.STELLAR_OBSERVE_ONLY===true,
    commandGate:gate.target,commandGateReturn:gate.returnAddress,
    actorRestriction:restriction.target,actorRestrictionReturn:restriction.returnAddress,
    activeResolver:active.target,activeResolverReturn:active.returnAddress,
    requestedRow:row.target,requestedRowReturn:row.returnAddress,
    dataManager:nativeSite('useDataManagerCall').target,refusalMarker:nativeAddress('useRefusalMarker'),
  });
  actionTrace.start();
  new NativeFunction(nativeModule.set_action_trace_update,'void',['pointer'])(actionTrace.observeUpdate);
  new NativeFunction(nativeModule.set_action_trace_automatic,'void',['pointer','pointer'])(actionTrace.automaticBefore,actionTrace.automaticAfter);
}

let rebindTimer = null;
let bindingReady = false;
let rebindDrainPending = false;
let activeBindingIdentity = null;
let activeObjectBindingIdentity = null;
let activePlayerGeneration = 0;
let activeEvadeSkillIds = [];
let rebinds = 0;
let bindingUnavailable = 0;
let rebindErrors = 0;
let accumulatedActionBindingKey = null;
let accumulatedActions = new Map();
let accumulatedActionList = [];
let accumulatedGuardBindingKey = null;
let accumulatedGuardActions = new Map();
let activeGuardSkillIds = [];
let commandDiscoveryErrors = 0;
let commandDiscoveryOverflow = 0;

function bindingIdentity(binding, actions, guards = []) {
  return [
    binding.actorManager.toString(),
    binding.actor.toString(),
    binding.stanceKey.toString(),
    binding.character.toString(),
    binding.collisionGroup.toString(),
    binding.logic.toString(),
    actions.map(action => action.skillId).sort((a,b)=>a-b).join(','),
    guards.map(action => action.skillId).sort((a,b)=>a-b).join(','),
    String(binding.generation),
  ].join('|');
}

function writeActionCandidates(actions) {
  actionCandidateBuffer.writeByteArray(new Uint8Array(MAX_ACTION_CANDIDATES * 16));
  actions.forEach((action, index) => {
    const at = actionCandidateBuffer.add(index * 16);
    at.writeU32(action.skillId >>> 0);
    at.add(4).writeU32(0);
    at.add(8).writePointer(action.commandKey);
  });
}

function writeGuardCandidates(guards) {
  guardCandidateBuffer.writeByteArray(new Uint8Array(MAX_ACTION_CANDIDATES*16));
  guards.forEach((action,index)=>{
    const at=guardCandidateBuffer.add(index*16);at.writeU32(action.skillId>>>0);
    at.add(4).writeU32(0);at.add(8).writePointer(action.commandKey);
  });
 }

function configureNativeBinding(binding, actions, guards = []) {
  writeActionCandidates(actions);writeGuardCandidates(guards);
  nativeGuardCandidatesConfig(guardCandidateBuffer,guards.length);
  nativeConfigure(
    binding.actor,
    binding.logic,
    binding.actorManager,
    binding.collisionGroup,
    actionCandidateBuffer,
    actions.length,
    resolvedProfile.functions.actorLogicUseSkill.address,
    resolvedProfile.functions.updateSkillLogic.address,
    resolvedProfile.functions.deactivateSkill.address,
    resolvedProfile.functions.selectCommandNode.address,
    resolvedProfile.functions.findActorByUniqueId.address,
    resolvedProfile.sites.projectileFilteredActorCaller.returnAddress,
    resolvedProfile.sites.projectileEligibilityGateCaller.returnAddress,
    resolvedProfile.sites.meleePairCall.returnAddress,
    binding.generation
  );
  nativeSetProbeAddresses(
    probeAddresses.angleSite,
    probeAddresses.consumer,
    probeAddresses.consumerReturn
  );
  activeBindingIdentity = bindingIdentity(binding, actions, guards);
  activeObjectBindingIdentity = bindingIdentity(binding, [], []);
  activeGuardSkillIds = guards.map(action=>action.skillId);
  activePlayerGeneration = binding.generation;
  activeEvadeSkillIds = actions.map(action => action.skillId);
  bindingReady = true;
  rebindDrainPending = false;
}

function verifyProbeSites(){
  const consumer=nativeSite('meleeConsumer'),resolution=nativeSite('meleeResolution');
  probeAddresses={angleSite:nativeAddress('meleeAngle'),justResolutionSite:resolution.returnAddress,
    consumer:consumer.target,consumerReturn:consumer.returnAddress};
  nativeSetProbeAddresses(probeAddresses.angleSite,probeAddresses.consumer,probeAddresses.consumerReturn);
  nativeSetMeleeSourceGateReturn(nativeSite('meleeSourceGate').returnAddress);
  return probeAddresses;
}

function actionBindingKey(binding) {
  return [
    binding.actorManager.toString(),
    binding.actor.toString(),
    binding.stanceKey.toString(),
    binding.logic.toString(),
    String(binding.generation),
  ].join('|');
}

function accumulateEvadeActions(binding, discovered) {
  const key = actionBindingKey(binding);
  if (key !== accumulatedActionBindingKey) {
    accumulatedActionBindingKey = key;
    accumulatedActions = new Map();
  }
  for (const action of discovered) {
    const old=accumulatedActions.get(action.skillId);
    if (!old || action.priority>old.priority) accumulatedActions.set(action.skillId, action);
  }
  if(accumulatedActions.size>MAX_ACTION_CANDIDATES)commandDiscoveryOverflow++;
  accumulatedActionList = Array.from(accumulatedActions.values())
    .sort((a,b) => b.priority-a.priority || a.skillId-b.skillId)
    .slice(0,MAX_ACTION_CANDIDATES);
  return accumulatedActionList;
}

function accumulateGuardActions(binding, discovered) {
  const key = actionBindingKey(binding);
  if (key !== accumulatedGuardBindingKey) {
    accumulatedGuardBindingKey = key;
    accumulatedGuardActions = new Map();
  }
  for (const action of discovered) {
    const old=accumulatedGuardActions.get(action.skillId);
    if (!old || action.priority>old.priority) accumulatedGuardActions.set(action.skillId,action);
  }
  if(accumulatedGuardActions.size>MAX_ACTION_CANDIDATES)commandDiscoveryOverflow++;
  return Array.from(accumulatedGuardActions.values())
    .sort((a,b) => b.priority-a.priority || a.skillId-b.skillId)
    .slice(0,MAX_ACTION_CANDIDATES);
}

function coldReadPointer(base, offset) {
  try { const value=ptr(base).add(offset).readPointer(); return value.isNull()?null:value; }
  catch (_) { return null; }
}

function coldReadU32(base, offset) {
  try { return ptr(base).add(offset).readU32(); } catch (_) { return null; }
}

function resolveCurrentCommandActions(binding,inputId,seeds) {
  const actions=new Map();
  const add=(skillId,commandKey,source,priority) => {
    if(!Number.isInteger(skillId)||skillId<=0||commandKey===null||commandKey.isNull())return;
    const previous=actions.get(skillId);
    if(previous && previous.priority>=(priority>>>0))return;
    actions.set(skillId,Object.freeze({playerGeneration:binding.generation,skillId,commandKey,source,priority:priority>>>0}));
  };
  // Known IDs are only startup seeds; actual Command aliases discover any
  // other native ordinary Evade/Parry family, including custom Mod IDs.
  for(const skillId of seeds) {
    try {
      const descriptor=runtimeSession.resolveActionDescriptor(inputId,skillId);
      if(descriptor && descriptor.playerGeneration===binding.generation && nativeQualifyActionId(skillId,inputId))
        add(skillId,descriptor.commandKey,'selector',coldReadU32(descriptor.commandNode,0x2c)||0);
    } catch (_) {}
  }
  // Preserve supported seeds during transient selector unavailability; the
  // native request always resolves a fresh key and checks its actual row.
  if(actions.size) {
    const seed=actions.values().next().value;
    for(const skillId of seeds) {
      try { if(nativeQualifyActionId(skillId,inputId))add(skillId,seed.commandKey,'selector:seed',0); } catch (_) {}
    }
  }
  const manager=coldReadPointer(binding.actor,locator.OFFSETS.actorCommandManager);
  if(manager!==null) {
    const vectors=[{source:'global',data:coldReadPointer(manager,0x10),count:coldReadU32(manager,0x18)}];
    for(const [offset,source] of [[0x70,'current'],[0x08,'fallback']]) {
      const context=coldReadPointer(manager,offset);
      if(context!==null)vectors.push({source,data:coldReadPointer(context,0x08),count:coldReadU32(context,0x10)});
    }
    const seenNodes=new Set();
    for(const vector of vectors) {
      if(vector.data===null||vector.count===null)continue;
      if(vector.count>MAX_COMMAND_NODES){commandDiscoveryErrors++;commandDiscoveryOverflow++;continue;}
      for(let index=0;index<vector.count;index++) {
        const node=coldReadPointer(vector.data,index*Process.pointerSize);
        if(node===null||seenNodes.has(node.toString()))continue;
        seenNodes.add(node.toString());
        if(coldReadU32(node,locator.OFFSETS.commandNodeInputId)!==inputId)continue;
        try {
          if(nativeReadCommandAction(node,inputId,commandActionBuffer))
            add(commandActionBuffer.readU32(),commandActionBuffer.add(8).readPointer(),
              `${vector.source}:native_alias`,commandActionBuffer.add(16).readU32());
        } catch (_) { commandDiscoveryErrors++; }
      }
    }
  }
  const result=Array.from(actions.values()).sort((a,b)=>b.priority-a.priority||a.skillId-b.skillId);
  if(result.length>MAX_ACTION_CANDIDATES)commandDiscoveryOverflow++;
  return result.slice(0,MAX_ACTION_CANDIDATES);
}

function resolveCurrentEvadeActions(binding) {
  return resolveCurrentCommandActions(binding,EVADE_INPUT_ID,EVADE_SKILL_CANDIDATES);
}

function resolveCurrentGuardActions(binding) {
  return typeof nativeGuardConfig==='undefined' || !capabilities.guard?.enabled || globalThis.STELLAR_GUARD_DISABLED===true ? [] :
    resolveCurrentCommandActions(binding,26,[1001202,1004101,1007001,6010257,6020271]);
}


function configureNativeSpecialRoute(){
  nativeSpecialConfig(...['dataManager','skillRowLookup','filterRowLookup','targetQuery','freeArray'].map(nativeAddress),Module.getGlobalExportByName('GetTickCount64'),
    globalThis.STELLAR_SPECIAL_DISABLED===true||globalThis.STELLAR_OBSERVE_ONLY===true?0:1);
}

function bindOnce() {
  nativeActionRowsConfig(...['dataManager','skillRowLookup','commandRowLookup','skillAliasLookup','filterRowLookup'].map(nativeAddress));
  const binding = runtimeSession.refreshPlayerBinding();
  if (binding === null) {
    nativeDisable();nativeGuardDrain();
    bindingReady = false;
    rebindDrainPending = true;
    bindingUnavailable += 1;
    return null;
  }
  const actions = accumulateEvadeActions(binding, resolveCurrentEvadeActions(binding));
  const guards = accumulateGuardActions(binding, resolveCurrentGuardActions(binding));
  configureNativeBinding(binding, actions, guards);
  return { binding, actions, guards };
}

function pollBinding() {
  if (stopped) return;
  let binding;
  let actions;
  let guards;
  try {
    binding = runtimeSession.refreshPlayerBinding();
    actions = binding === null
      ? []
      : accumulateEvadeActions(binding, resolveCurrentEvadeActions(binding));
    guards=binding===null ? [] : accumulateGuardActions(binding,resolveCurrentGuardActions(binding));
  } catch (_) {
    binding = null;
    actions = [];
    guards = [];
    rebindErrors += 1;
  }

  if (binding === null) {
    bindingUnavailable += 1;
    if (bindingReady || !rebindDrainPending) {
      nativeDisable();nativeGuardDrain();
      bindingReady = false;
      rebindDrainPending = true;
    }
    return;
  }

  const identity = bindingIdentity(binding, actions, guards);
  if (bindingReady && identity === activeBindingIdentity) return;
  if (bindingReady && activeObjectBindingIdentity===bindingIdentity(binding,[],[])) {
    writeActionCandidates(actions);writeGuardCandidates(guards);
    const result=nativeExtendCandidates(binding.actor,binding.logic,binding.generation,
      actionCandidateBuffer,actions.length,guardCandidateBuffer,guards.length);
    if((result&8)===0) {
      activeBindingIdentity=identity;
      activeEvadeSkillIds=Array.from(new Set([...activeEvadeSkillIds,...actions.map(x=>x.skillId)])).slice(0,MAX_ACTION_CANDIDATES);
      activeGuardSkillIds=Array.from(new Set([...activeGuardSkillIds,...guards.map(x=>x.skillId)])).slice(0,MAX_ACTION_CANDIDATES);
      if(result&4)commandDiscoveryOverflow++;
      return;
    }
  }

  // First observation disables the native policy. A later timer turn
  // re-resolves all objects before configure, so in-flight wrappers have
  // exited without a blocking sleep on either thread.
  if (!rebindDrainPending) {
    nativeDisable();nativeGuardDrain();
    bindingReady = false;
    rebindDrainPending = true;
    return;
  }

  if(nativeGuardPending())return; // Retain ownership until native scheduler drains.
  configureNativeBinding(binding, actions, guards);
  rebinds += 1;
}

function snapshotPerfectCount() {
  const count = nativeReadMeleeDiag(meleeDiagBuffer, MELEE_DIAG_CAPACITY);
  if (count === 0) return '0';
  const view = new DataView(meleeDiagBuffer.readByteArray(count * meleeDiagRecordSize));
  let total = 0n;
  for (let i = 0; i < count; i += 1) {
    const at = i * meleeDiagRecordSize;
    // Match snapshotMeleeDiag/snapshotAttemptDiag's validity filters exactly.
    if (view.getBigUint64(at,true) === 0n || view.getBigUint64(at+8,true) === 0n ||
        view.getBigUint64(at+32,true) === 0n || view.getBigUint64(at+304,true) === 0n) continue;
    total += view.getBigUint64(at+496,true);
  }
  return total.toString();
}

function snapshotCompactStatus() {
  nativeReadStats(statsBuffer);
  const counts = new DataView(statsBuffer.readByteArray(24));
  nativeSpecialStats(specialStatsBuffer);
  const special = new DataView(specialStatsBuffer.readByteArray(152));
  const number = i => special.getBigUint64(i*8,true).toString();
  const result = {
    profile:resolvedProfile.profileId,compatibility:snapshotCompatibility(),bindingStatus:snapshotBindingStatus(),commandDiscovery:snapshotCommandDiscovery(), bindingReady, stopped, playerGeneration:activePlayerGeneration,
    rebindErrors, rebinds, telemetryDetail:'summary', diagnosticsEnabled:actionTrace !== null,
    stats:{attempts:counts.getBigUint64(0,true).toString(),
      installed:counts.getBigUint64(8,true).toString(),rejected:counts.getBigUint64(16,true).toString()},
    perfectCount:snapshotPerfectCount(),
    inputPriority:snapshotInputPriority(),
    healthTrace:snapshotHealthTrace(),
    specialResponses:{enabled:number(14)==='1',requests:number(3),returnedNull:number(4),
      blue:number(5),purple:number(6),active:number(7)==='1',lastSkill:number(9),
      initialStep:number(12),latestStep:number(13)}
  };
  nativeGuardStats(guardStatsBuffer);
  const guard = new DataView(guardStatsBuffer.readByteArray(80));
  result.guardRoute = {requests:guard.getBigUint64(56,true).toString(),
    installed:guard.getBigUint64(64,true).toString(),refused:guard.getBigUint64(72,true).toString()};
  return result;
}

function snapshotStats() {
  nativeReadStats(statsBuffer);
  return Object.freeze({
    attempts: statsBuffer.readU64(),
    installed: statsBuffer.add(8).readU64(),
    rejected: statsBuffer.add(16).readU64(),
    meleeCalls: statsBuffer.add(24).readU64(),
    hitBuilderCalls: statsBuffer.add(32).readU64(),
    playerMatches: statsBuffer.add(40).readU64(),
    actionClaims: statsBuffer.add(48).readU64(),
    projectileCalls: statsBuffer.add(56).readU64(),
    deferredHits: statsBuffer.add(64).readU64(),
    retryHits: statsBuffer.add(72).readU64(),
    sameBuilderResultCalls: statsBuffer.add(80).readU64(),
    laterBuilderResultCalls: statsBuffer.add(88).readU64(),
    primaryNumAtDefer: statsBuffer.add(96).readU64(),
    secondaryNumAtDefer: statsBuffer.add(104).readU64(),
    ownedNaturalUpdates: statsBuffer.add(112).readU64(),
    waitingDefers: statsBuffer.add(120).readU64(),
    releasedAfterUpdate: statsBuffer.add(128).readU64(),
    failOpenReleases: statsBuffer.add(136).readU64(),
    blockedProjectileLeases: statsBuffer.add(144).readU64(),
    releasedResultCalls: statsBuffer.add(152).readU64(),
    rearmedAttacks: statsBuffer.add(160).readU64(),
    nativeStops: statsBuffer.add(168).readU64(),
    stopConfirmed: statsBuffer.add(176).readU64(),
    stopFailed: statsBuffer.add(184).readU64(),
    restartAttempts: statsBuffer.add(192).readU64(),
    restartInstalled: statsBuffer.add(200).readU64(),
    restartRejected: statsBuffer.add(208).readU64(),
    gateTrueSeen: statsBuffer.add(216).readU64(),
    gateSuppressed: statsBuffer.add(224).readU64(),
    sameProjectileGateReentered: statsBuffer.add(232).readU64(),
    releasedOriginalTrue: statsBuffer.add(240).readU64(),
    meleePairTrueSeen: statsBuffer.add(248).readU64(),
    meleePairRequests: statsBuffer.add(256).readU64(),
    meleePairInstalled: statsBuffer.add(264).readU64(),
    meleePairConsumed: statsBuffer.add(272).readU64(),
    selectorReturned: statsBuffer.add(280).readU64(),
    selectorFallbackUsed: statsBuffer.add(288).readU64(),
    requestReturnedNonNull: statsBuffer.add(296).readU64(),
    requestReturnedNull: statsBuffer.add(304).readU64(),
    runtimeChanged: statsBuffer.add(312).readU64(),
    pendingState: statsBuffer.add(320).readU64(),
    forcedBfd340Issued: statsBuffer.add(328).readU64(),
    activeState: statsBuffer.add(336).readU64(),
    currentStepEstablished: statsBuffer.add(344).readU64(),
    oldOwnedActive: statsBuffer.add(352).readU64(),
    naturalBfd340Seen: statsBuffer.add(360).readU64(),
    pendingCreated: statsBuffer.add(368).readU64(),
    pendingDeferrals: statsBuffer.add(376).readU64(),
    pendingRechecks: statsBuffer.add(384).readU64(),
    installedAfterWait: statsBuffer.add(392).readU64(),
    pendingInvalidated: statsBuffer.add(400).readU64(),
  });
}

function snapshotAttemptDiag(at) {
  const sequence = at.add(304).readU64();
  if (sequence.compare(0) === 0) return null;
  return {
    sequence: sequence.toString(),
    installed: at.add(312).readU64().toString(),
    nativeAccepted: at.add(320).readU64().toString(),
    runtimeBefore: at.add(328).readU64().toString(),
    runtimeAfter: at.add(336).readU64().toString(),
    ownedSnapshotValid: at.add(344).readU64().toString(),
    ownedStepId: at.add(352).readU64().toString(),
    ownedStepType: at.add(360).readU64().toString(),
    windowBeforeLease: at.add(368).readFloat(),
    ownedTargetCount: at.add(376).readU64().toString(),
    sourceActorKey: at.add(384).readU64().toString(),
    sourceInOwnedTargets: at.add(392).readU64().toString(),
    resultStepId: at.add(400).readU64().toString(),
    resultWindowBeforeRestore: at.add(408).readFloat(),
    defenderGateSeen: at.add(416).readU64().toString(),
    defenderGatePassed: at.add(424).readU64().toString(),
    ownedRowAlias110: at.add(432).readPointer().toString(),
    angleProbeSeen: at.add(440).readU64().toString(),
    angleResultAl: at.add(448).readU64().toString(),
    angleSourceMatch: at.add(456).readU64().toString(),
    angleDefenderMatch: at.add(464).readU64().toString(),
    angleThreshold: at.add(472).readFloat(),
    angleSource: at.add(480).readPointer().toString(),
    angleDefender: at.add(488).readPointer().toString(),
    justConsumerCalls: at.add(496).readU64().toString(),
    justConsumerMatched: at.add(504).readU64().toString(),
    justConsumerCompleted: at.add(512).readU64().toString(),
    justConsumerResultType: at.add(520).readU64().toString(),
    justConsumerDescriptor: at.add(528).readPointer().toString(),
    justConsumerStepId: at.add(536).readU64().toString(),
    justConsumerStepType: at.add(544).readU64().toString(),
    justResolutionSeen: at.add(552).readU64().toString(),
    justResolutionDescriptor: at.add(560).readPointer().toString(),
    justResolutionStepId: at.add(568).readU64().toString(),
    justResolutionStepType: at.add(576).readU64().toString(),
    nativeSelectorDeferred: at.add(584).readU64().toString(),
    nativeRequestSubmitted: at.add(592).readU64().toString(),
  };
}

function snapshotRangedRequestDiag() {
  nativeReadRangedRequestDiag(rangedRequestDiagBuffer);
  return snapshotAttemptDiag(rangedRequestDiagBuffer);
}

function snapshotMeleeDiag() {
  const count = nativeReadMeleeDiag(meleeDiagBuffer, MELEE_DIAG_CAPACITY);
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const at = meleeDiagBuffer.add(index * meleeDiagRecordSize);
    const source = at.readPointer();
    const step = at.add(8).readPointer();
    const calls = at.add(32).readU64();
    if (source.isNull() || step.isNull() || calls.compare(0) === 0) continue;
    rows.push({
      source: source.toString(),
      step: step.toString(),
      generation: at.add(16).readU32(),
      stepId: at.add(20).readU32(),
      stepType: at.add(24).readU32(),
      sourceEpoch: at.add(28).readU32(),
      calls: calls.toString(),
      blockedActive: at.add(40).readU64().toString(),
      duplicateSuppressed: at.add(48).readU64().toString(),
      requests: at.add(56).readU64().toString(),
      installed: at.add(64).readU64().toString(),
      lastResult: at.add(72).readU64().toString(),
      nativeStops: at.add(80).readU64().toString(),
      stopConfirmed: at.add(88).readU64().toString(),
      stopFailed: at.add(96).readU64().toString(),
      restartAttempts: at.add(104).readU64().toString(),
      restartInstalled: at.add(112).readU64().toString(),
      restartRejected: at.add(120).readU64().toString(),
      epochAfter: at.add(128).readU64().toString(),
      interaction: at.add(136).readPointer().toString(),
      interactionClass: at.add(144).readU64().toString(),
      outAccepted: at.add(152).readU64().toString(),
      selectorReturned: at.add(160).readU64().toString(),
      selectorFallbackUsed: at.add(168).readU64().toString(),
      requestReturnedNonNull: at.add(176).readU64().toString(),
      requestReturnedNull: at.add(184).readU64().toString(),
      runtimeChanged: at.add(192).readU64().toString(),
      pendingState: at.add(200).readU64().toString(),
      forcedBfd340Issued: at.add(208).readU64().toString(),
      activeState: at.add(216).readU64().toString(),
      currentStepEstablished: at.add(224).readU64().toString(),
      oldOwnedActive: at.add(232).readU64().toString(),
      naturalBfd340Seen: at.add(240).readU64().toString(),
      tokenExpirations: at.add(248).readU64().toString(),
      acceptedTrue: at.add(256).readU64().toString(),
      acceptedFalse: at.add(264).readU64().toString(),
      sourceGateCalls: at.add(272).readU64().toString(),
      sourceGateTrue: at.add(280).readU64().toString(),
      sourceGateFalse: at.add(288).readU64().toString(),
      availableJustAction: at.add(296).readU64().toString(),
      lastAttempt: snapshotAttemptDiag(at),
    });
  }
  return rows;
}

let cleanupPromise = null;
function cleanup() {
  if(cleanupPromise===null)cleanupPromise=cleanupCore();
  return cleanupPromise;
}
async function cleanupCore() {
  send({type:'cleanup_stage',stage:'begin',atMs:Date.now()});
  new NativeFunction(nativeModule.set_action_trace_update,'void',['pointer'])(NULL);
  new NativeFunction(nativeModule.set_action_trace_automatic,'void',['pointer','pointer'])(NULL,NULL);
  if (stopped) return;
  stopped = true;
  if (rebindTimer !== null) {
    clearInterval(rebindTimer);
    rebindTimer = null;
  }
  nativeDisable();nativeGuardDrain();
  priorityDisable();
  if (prioritySelectorListener !== null) { prioritySelectorListener.detach(); prioritySelectorListener = null; }
  send({type:'cleanup_stage',stage:'guard_drain',pending:nativeGuardPending(),atMs:Date.now()});
  // Stop admission immediately, retain the scheduler hook until its owned
  // Guard is terminal. A paused game drains on its next natural update.
  // Never stop a native SkillLogic from this cold JS/RPC thread.
  while(nativeGuardPending())await new Promise(resolve=>setTimeout(resolve,100));
  send({type:'cleanup_stage',stage:'guard_drained',atMs:Date.now()});
  if(healthListener!==null){healthListener.detach();healthListener=null;}
  for(const listener of effectListeners)listener.detach();
  effectListeners=[];
  if(guardInitialStepListener!==null){guardInitialStepListener.detach();guardInitialStepListener=null;}
  if (meleeSourceGateListener !== null) {
    meleeSourceGateListener.detach();
    meleeSourceGateListener = null;
  }
  if (angleProbeListener !== null) {
    angleProbeListener.detach();
    angleProbeListener = null;
  }
  if (justConsumerListener !== null) {
    justConsumerListener.detach();
    justConsumerListener = null;
  }
  if(movementInputSite!==null){Interceptor.revert(movementInputSite);movementInputSite=null;}
  if(movementSelectionSite!==null){Interceptor.revert(movementSelectionSite);movementSelectionSite=null;}
  if (justResolutionListener !== null) {
    justResolutionListener.detach();
    justResolutionListener = null;
  }
  if (filteredActorListener !== null) {
    filteredActorListener.detach();
    filteredActorListener = null;
  }
  if (projectileEligibilityGateListener !== null) {
    projectileEligibilityGateListener.detach();
    projectileEligibilityGateListener = null;
  }
  if (meleePairListener !== null) {
    meleePairListener.detach();
    meleePairListener = null;
  }
  if (hitRecordsInstalled) {
    Interceptor.revert(resolvedProfile.functions.projectileHitRecords.address);
  }
  if (projectileInstalled) {
    Interceptor.revert(resolvedProfile.functions.projectileArbitrate.address);
  }
  if (meleeInstalled) {
    Interceptor.revert(resolvedProfile.functions.meleeDefenseArbitrate.address);
  }
  if (updateInstalled) {
    Interceptor.revert(resolvedProfile.functions.updateSkillLogic.address);
  }
  if (priorityUseSkillInstalled) {
    Interceptor.revert(resolvedProfile.functions.actorLogicUseSkill.address);
    priorityUseSkillInstalled = false;
  }
  Interceptor.flush();
  hitRecordsOriginalSlot.writePointer(NULL);
  projectileOriginalSlot.writePointer(NULL);
  meleeOriginalSlot.writePointer(NULL);
  updateOriginalSlot.writePointer(NULL);
  movementOriginalSlot.writePointer(NULL);
  movementSelectOriginalSlot.writePointer(NULL);
  priorityUseSkillTargetSlot.writePointer(NULL);
  hitRecordsInstalled = false;
  projectileInstalled = false;
  meleeInstalled = false;
  updateInstalled = false;
  nativeClearState();
  send({type:'cleanup_stage',stage:'core_hooks_removed',atMs:Date.now()});
  if (actionTrace !== null) actionTrace.stop();
  send({type:'cleanup_stage',stage:'complete',atMs:Date.now()});
}

new NativeFunction(nativeModule.set_dodge_disabled,'void',['uint32'])(globalThis.STELLAR_DODGE_DISABLED===true||globalThis.STELLAR_OBSERVE_ONLY===true?1:0);

// Product host cleanup registration: every installed hook has an awaitable stop.
rpc.exports={async stop(){await cleanup();return true;}};

try {
  markStartup('cold_configuration');
  prepareCompatibility();
  verifyProbeSites();
  enableCapability('special',configureNativeSpecialRoute,()=>nativeSpecialConfig(NULL,NULL,NULL,NULL,NULL,NULL,0));
  enableCapability('guard',configureNativeGuardRoute,()=>{nativeGuardConfig(NULL,NULL,NULL,NULL,NULL,0);if(guardInitialStepListener!==null){guardInitialStepListener.detach();guardInitialStepListener=null;}});
  enableCapability('projectileGuard',configureNativeProjectileGuard,()=>nativeProjectileGuardConfig(NULL,NULL,NULL));
  // A9D900 is both a Guard API and an observed request-row resolver.
  // Validate its original bytes before our observer installs its trampoline.
  enableCapability('diagnostics',startActionTrace,()=>{if(actionTrace!==null){actionTrace.stop();actionTrace=null;}new NativeFunction(nativeModule.set_action_trace_update,'void',['pointer'])(NULL);new NativeFunction(nativeModule.set_action_trace_automatic,'void',['pointer','pointer'])(NULL,NULL);});
  enableCapability('effect',installEffectResponses,()=>{effectConfigure(effectState,NULL,NULL,0);for(const listener of effectListeners)listener.detach();effectListeners=[];});
  enableCapability('health',installHealthTrace,()=>{new NativeFunction(nativeModule.configure_health_trace,'void',['pointer','pointer','uint32'])(healthState,NULL,0);if(healthListener!==null){healthListener.detach();healthListener=null;}});
  markStartup('route_configuration');
  const startup = bindOnce();
  markStartup('player_binding');
  enableCapability('inputPriority',installInputPriority,()=>{priorityDisable();if(prioritySelectorListener!==null){prioritySelectorListener.detach();prioritySelectorListener=null;}if(priorityUseSkillInstalled){Interceptor.revert(resolvedProfile.functions.actorLogicUseSkill.address);priorityUseSkillInstalled=false;}});
  markStartup('hook_input_priority');
  const updateOriginal = Interceptor.replaceFast(
    resolvedProfile.functions.updateSkillLogic.address,
    nativeModule.update_skill_wrapper
  );
  updateOriginalSlot.writePointer(updateOriginal);
  updateInstalled = true;
  markStartup('hook_update');

  const meleeOriginal = Interceptor.replaceFast(
    resolvedProfile.functions.meleeDefenseArbitrate.address,
    nativeModule.melee_wrapper
  );
  meleeOriginalSlot.writePointer(meleeOriginal);
  meleeInstalled = true;
  markStartup('hook_melee');

  const projectileOriginal = Interceptor.replaceFast(
    resolvedProfile.functions.projectileArbitrate.address,
    nativeModule.projectile_wrapper
  );
  projectileOriginalSlot.writePointer(projectileOriginal);
  projectileInstalled = true;
  markStartup('hook_projectile');

  const hitRecordsOriginal = Interceptor.replaceFast(
    resolvedProfile.functions.projectileHitRecords.address,
    nativeModule.hit_records_wrapper
  );
  hitRecordsOriginalSlot.writePointer(hitRecordsOriginal);
  hitRecordsInstalled = true;
  markStartup('hook_hit_records');
  filteredActorListener = Interceptor.attach(
    resolvedProfile.functions.findActorByUniqueId.address,
    {
      onEnter: nativeModule.actor_resolve_on_enter,
      onLeave: nativeModule.actor_resolve_on_leave,
    }
  );

  markStartup('hook_actor_resolve');
  meleeSourceGateListener = Interceptor.attach(
    resolvedProfile.functions.projectileEligibilityGate.address,
    {
      onEnter: nativeModule.melee_source_gate_on_enter,
      onLeave: nativeModule.melee_source_gate_on_leave,
    }
  );
  markStartup('hook_source_gate');
  // No mid-function angle hook: native branches target angleSite+8, inside
  // Frida's long detour data. Observe the function-entry Just consumer below.
  const movementSite=nativeAddress('movement'),movementSelectSite=nativeAddress('movementSelect');
  movementSelectOriginalSlot.writePointer(Interceptor.replaceFast(movementSelectSite,nativeModule.movement_select_native_wrapper));
  movementSelectionSite=movementSelectSite;
  movementOriginalSlot.writePointer(Interceptor.replaceFast(movementSite,nativeModule.movement_native_wrapper));
  movementInputSite=movementSite;
  markStartup('hooks_movement');
  // Descriptor resolution is observed through the consumer's arguments,
  // without overwriting another instruction in the middle of BFE9E0.
  justConsumerListener = Interceptor.attach(probeAddresses.consumer, {
    onEnter: nativeModule.just_consumer_on_enter,
    onLeave: nativeModule.just_consumer_on_leave,
  });

  markStartup('hook_just_consumer');
  Interceptor.flush();
  capabilities.core.enabled=true;
  markStartup('hooks_flushed');
  flushStartupTimings();
  rebindTimer = setInterval(pollBinding, BINDING_REFRESH_MS);

  rpc.exports = {
    status(options) {
      if (options && options.includeDiagnostics === false) return snapshotCompactStatus();
      const includeDetails = !options || options.includeDetails !== false;
      const stats = snapshotStats();
      return {
        profile: resolvedProfile.profileId,
        compatibility:snapshotCompatibility(),bindingStatus:snapshotBindingStatus(),commandDiscovery:snapshotCommandDiscovery(),
        policy: 'combined_defense_v11_gameplay_not_yet_accepted',
        diagnosticOnly: false,
        nativeSelectorDeferred: nativeReadSelectorDeferred().toString(),
        diagnosticMeaning: 'lastAttempt is the latest selector evaluation; nativeRequestSubmitted=0 means no UseSkill was issued and no source-Step token was consumed. Native command queue creation remains disabled. A refused action may hold only its original qualified interaction and re-evaluate on a later native event after the player phase changes. Full action, Perfect and damage outcomes still need gameplay evidence.',
        angleProbeInstalled: angleProbeListener !== null,
        justResolutionProbeInstalled: justResolutionListener !== null,
        justConsumerProbeInstalled: justConsumerListener !== null,
        sourceDirection: snapshotDirectionPolicy(),
        effectResponses: snapshotEffectResponses(),
        healthTrace: snapshotHealthTrace(),
        inputPriority: snapshotInputPriority(),
        specialResponses: snapshotSpecialResponses(),
        guardRoute: snapshotGuardRoute(),
        projectileGuard: snapshotProjectileGuard(),
        combinedPolicy:'Melee and ranged: native Guard availability/filter qualification first, otherwise Dodge. Native action and Perfect result retained; no mid-function diagnostic hooks.',
        movementTrace: includeDetails ? snapshotMovementTrace() : [],
        movementNativeInstalled: movementInputSite!==null && movementSelectionSite!==null,
        effectiveInputPolicy:'For this automatic Sword Evade only, provide its requested world direction to the observed native mode3 movement consumer; native normalization, action and Perfect result retained.', 
        movementTraceMeaning: 'Read-only BA2E40/BE3BC0 input and movement selection trace; absent rows are unknown.',
        inputPolicy: 'Ordinary automated Evade follows the current source direction; special responses retain native Blink/Repulse eligibility and movement.',
        activationPolicy: 'Native UseSkill argument8 permits this automatic activation through BlockSkill gates; command queue stays disabled and native Step/Just/result checks remain.',
        initializationTrace: includeDetails ? snapshotInitializationTrace() : [],
        actionTrace: actionTrace === null ? null : actionTrace.snapshot(options && options.afterTraceSerial),
        telemetryDetail: includeDetails ? 'full' : 'compact',
        initializationTraceMeaning: 'V7 changes only submitted ordinary-Evade input; native movement initialization/result evidence retained. Unobserved phases remain unknown.',
        continuation: { created: stats.pendingCreated.toString(), deferrals: stats.pendingDeferrals.toString(), rechecks: stats.pendingRechecks.toString(), installedAfterWait: stats.installedAfterWait.toString(), invalidated: stats.pendingInvalidated.toString() },
        rangedLastRequest: snapshotRangedRequestDiag(),
        meleeSourceGateInstalled: meleeSourceGateListener !== null,
        meleeInstalled,
        projectileInstalled,
        hitRecordsInstalled,
        updateInstalled,
        filteredActorInstalled: filteredActorListener !== null,
        projectileEligibilityGateInstalled: projectileEligibilityGateListener !== null,
        meleePairInstalled: meleePairListener !== null,
        stopped,
        bindingReady,
        bindingRefreshMs: BINDING_REFRESH_MS,
        playerGeneration: activePlayerGeneration,
        evadeSkillIds: activeEvadeSkillIds,
        rebinds,
        bindingUnavailable,
        rebindErrors,
        stats: {
          attempts: stats.attempts.toString(),
          installed: stats.installed.toString(),
          rejected: stats.rejected.toString(),
          meleeCalls: stats.meleeCalls.toString(),
          hitBuilderCalls: stats.hitBuilderCalls.toString(),
          playerMatches: stats.playerMatches.toString(),
          actionClaims: stats.actionClaims.toString(),
          projectileCalls: stats.projectileCalls.toString(),
          deferredHits: stats.deferredHits.toString(),
          retryHits: stats.retryHits.toString(),
          sameBuilderResultCalls: stats.sameBuilderResultCalls.toString(),
          laterBuilderResultCalls: stats.laterBuilderResultCalls.toString(),
          primaryNumAtDefer: stats.primaryNumAtDefer.toString(),
          secondaryNumAtDefer: stats.secondaryNumAtDefer.toString(),
          ownedNaturalUpdates: stats.ownedNaturalUpdates.toString(),
          waitingDefers: stats.waitingDefers.toString(),
          releasedAfterUpdate: stats.releasedAfterUpdate.toString(),
          failOpenReleases: stats.failOpenReleases.toString(),
          blockedProjectileLeases: stats.blockedProjectileLeases.toString(),
          releasedResultCalls: stats.releasedResultCalls.toString(),
          rearmedAttacks: stats.rearmedAttacks.toString(),
          nativeStops: stats.nativeStops.toString(),
          stopConfirmed: stats.stopConfirmed.toString(),
          stopFailed: stats.stopFailed.toString(),
          restartAttempts: stats.restartAttempts.toString(),
          restartInstalled: stats.restartInstalled.toString(),
          restartRejected: stats.restartRejected.toString(),
          gateTrueSeen: stats.gateTrueSeen.toString(),
          gateSuppressed: stats.gateSuppressed.toString(),
          sameProjectileGateReentered: stats.sameProjectileGateReentered.toString(),
          releasedOriginalTrue: stats.releasedOriginalTrue.toString(),
          meleePairTrueSeen: stats.meleePairTrueSeen.toString(),
          meleePairRequests: stats.meleePairRequests.toString(),
          meleePairInstalled: stats.meleePairInstalled.toString(),
          meleePairConsumed: stats.meleePairConsumed.toString(),
          selectorReturned: stats.selectorReturned.toString(),
          selectorFallbackUsed: stats.selectorFallbackUsed.toString(),
          requestReturnedNonNull: stats.requestReturnedNonNull.toString(),
          requestReturnedNull: stats.requestReturnedNull.toString(),
          runtimeChanged: stats.runtimeChanged.toString(),
          pendingState: stats.pendingState.toString(),
          forcedBfd340Issued: stats.forcedBfd340Issued.toString(),
          activeState: stats.activeState.toString(),
          currentStepEstablished: stats.currentStepEstablished.toString(),
          oldOwnedActive: stats.oldOwnedActive.toString(),
          naturalBfd340Seen: stats.naturalBfd340Seen.toString(),
        },
        directAttemptInterpretation:
          'rejected is a legacy incomplete-acceptance aggregate; use stage counters',
        meleeSteps: snapshotMeleeDiag(),
      };
    },
    async stop() {
      await cleanup();
      return true;
    },
  };

  console.log(
    `[auto_evade_hit_records] ready profile=${resolvedProfile.profileId}` +
    ' route=melee native live selector, ranged filtered natural update hot_path=native'
  );
} catch (error) {
  cleanup();
  throw error;
}
