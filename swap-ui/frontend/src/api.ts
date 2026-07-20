// Types + fetch helpers for the gb10 swap backend (see ../../app.py).

export type SwapState = "idle" | "running" | "done" | "error";

export interface SwapJob {
  id: number;
  model_id: string | null;
  phase: string | null; // stopping | draining | starting | waiting-health
  state: SwapState;
  result: string | null; // "SWAPPED <name>" | "NOOP <name>" | "WEDGED" | "ERROR <msg>"
  progress: string | null; // latest tqdm-style line during first-boot download/load, if any
  started_at: number | null;
  finished_at: number | null;
  log_tail: string[];
}

export interface Gpu {
  ok: boolean;
  wedged: boolean;
  name?: string;
  mem_used_mb?: number;
  mem_total_mb?: number;
  mem_pct?: number;
  util_pct?: number;
  temp_c?: number;
  detail?: string;
}

export interface Current {
  container: string | null;
  served_name: string | null;
  model_id: string | null;
  healthy: boolean;
  loaded: boolean;
  uptime_s: number | null;
}

export interface Connections {
  running: number;
  waiting: number;
}

export interface Throughput {
  gen_tok_s: number | null;
  total_gen_tokens: number;
  total_prompt_tokens: number;
  total_requests: number;
}

export interface Status {
  current: Current;
  gpu: Gpu;
  connections: Connections | null;
  throughput: Throughput | null;
  swap: SwapJob;
  serve_port: number;
  ts: number;
}

export interface Ups {
  available: boolean;
  detail?: string;
  model?: string | null;
  status?: string;
  online?: boolean;
  on_battery?: boolean;
  charge_pct?: number | null;
  load_pct?: number | null;
  watts?: number | null;
  nom_power_w?: number | null;
  timeleft_min?: number | null;
  line_v?: number | null;
  batt_v?: number | null;
  temp_c?: number | null;
  time_on_batt_s?: number | null;
  last_xfer?: string | null;
}

export interface Model {
  id: string;
  served_name: string;
  container: string;
  repo: string;
  cache_dir: string;
  label: string;
  desc: string;
  size: string;
  speed: string;
  use_cases: string[];
  experimental: boolean;
  source: "committed" | "draft";
  downloaded: boolean;
}

// Editable recipe shape returned by /import/inspect and posted to /api/models.
export interface Recipe {
  id: string;
  label: string;
  desc: string;
  size: string;
  experimental: boolean;
  repo: string;
  served_name: string;
  max_len: number;
  gpu_util: string;
  quant: string;
  tools: boolean;
  reasoning_parser: string;
  spec_decode: boolean;
  extra_args: string;
  warnings?: string[];
  detected?: Record<string, unknown>;
}

export interface InspectResp {
  repo: string;
  config_found: boolean;
  recipe: Recipe;
  token_present: boolean;
}

export interface HfLookup {
  repo: string;
  architecture: string | null;
  max_position_embeddings: number | null;
  quantization_config: Record<string, unknown> | null;
  dtype: string | null;
  moe: { num_experts: number | null; top_k_experts: number | null } | null;
  total_bytes: number;
}

export interface DownloadJob {
  id: number;
  repo: string | null;
  state: "idle" | "running" | "done" | "error";
  progress: string | null;
  result: string | null;
  started_at: number | null;
  finished_at: number | null;
  log_tail: string[];
}

// --- Standard benchmark types (vLLM + lm-eval-harness) ---

export interface BenchmarkConfig {
  serving_requests: number;
  serving_concurrency: number;
  serving_input_len: number;
  serving_output_len: number;
  serving_dataset: string;
  eval_tasks: string[];
  eval_limit: number | null;
  eval_batch_size: number;
  timeout_serving: number;
  timeout_eval: number;
}

export interface BenchmarkPhaseResult {
  // Parsed metrics from the benchmark
  [key: string]: any;
  // Raw output for debugging
  _raw?: string;
  _error?: string;
  _passed?: boolean;
}

export interface BenchmarkResult {
  model_id: string;
  served_name: string;
  timestamp: number;
  config: BenchmarkConfig;
  serving: BenchmarkPhaseResult;
  serving_raw: string;
  serving_error: string | null;
  serving_passed: boolean;
  evaluation: BenchmarkPhaseResult;
  evaluation_raw: string;
  evaluation_error: string | null;
  evaluation_passed: boolean;
  gpu_snapshot: Gpu;
  all_passed: boolean;
}

export interface TestJob {
  id: number;
  model_id: string | null;
  served_name: string | null;
  state: "idle" | "running" | "done" | "error";
  experimental_cleared: boolean;
  started_at: number | null;
  finished_at: number | null;
  benchmark: BenchmarkResult;
  report?: BenchmarkResult; // backward compat alias
}

// Offline throughput benchmark — DISRUPTIVE (unloads the model, benchmarks a throwaway
// standalone instance, reloads the model). Kept as a separate job/type from the safe suite
// above; the UI must confirm with the user before calling api.benchmarkThroughput().
export interface ThroughputResult {
  model_id: string;
  model_repo: string;
  timestamp: number;
  throughput_num_prompts: number;
  throughput_input_len: number;
  throughput_output_len: number;
  throughput: BenchmarkPhaseResult;
  throughput_raw: string;
  throughput_error: string | null;
  throughput_passed: boolean;
  gpu_snapshot: Gpu;
}

export interface ThroughputJob {
  id: number;
  model_id: string | null;
  served_name: string | null;
  state: "idle" | "running" | "done" | "error";
  phase: "stopping" | "draining" | "benchmarking" | "reloading" | null;
  reload_ok: boolean | null;
  started_at: number | null;
  finished_at: number | null;
  result: ThroughputResult | Record<string, never>;
}

export interface UpdateJob {
  id: number;
  action: string | null;
  state: "idle" | "running" | "done" | "error";
  result: string | null;
  started_at: number | null;
  finished_at: number | null;
  log_tail: string[];
}

export interface UpdatesInfo {
  count: number;
  security: number | null;
  packages: { name: string; new: string; old: string }[];
  job: UpdateJob;
}

export interface DiskModel {
  id: string;
  label: string;
  cache_dir: string;
  bytes: number;
  loaded: boolean;
  loading: boolean;
}

export interface DiskInfo {
  fs: { total: number; used: number; free: number; pct: number } | null;
  cache_bytes: number;
  incomplete_bytes: number;
  models: DiskModel[];
}

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { detail?: string }).detail || `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  status: () => fetch("/api/status").then(j<Status>),
  ups: () => fetch("/api/ups").then(j<Ups>),
  models: () => fetch("/api/models").then(j<{ models: Model[]; current: Current }>),
  refresh: () => fetch("/api/models/refresh", { method: "POST" }).then(j<{ models: Model[] }>),
  swap: (model_id: string) =>
    fetch("/api/swap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model_id }),
    }).then(j<{ accepted: boolean; job: SwapJob }>),
  swapStatus: () => fetch("/api/swap/status").then(j<SwapJob>),
  swapCancel: () => fetch("/api/swap/cancel", { method: "POST" }).then(j<{ cancelling: boolean }>),
  unload: () => fetch("/api/unload", { method: "POST" }).then(j<{ unloaded: string[] }>),
  reboot: () => fetch("/api/reboot", { method: "POST" }).then(j<{ rebooting: boolean }>),

  test: () => fetch("/api/test", { method: "POST" }).then(j<{ accepted: boolean; test: TestJob }>),
  testStatus: () => fetch("/api/test/status").then(j<TestJob>),

  // Caller MUST confirm with the user first — this takes the model offline for several minutes
  // (unload -> benchmark a throwaway standalone instance -> reload).
  benchmarkThroughput: () =>
    fetch("/api/benchmark/throughput", { method: "POST" }).then(
      j<{ accepted: boolean; throughput: ThroughputJob }>
    ),
  benchmarkThroughputStatus: () => fetch("/api/benchmark/throughput/status").then(j<ThroughputJob>),

  updates: () => fetch("/api/updates").then(j<UpdatesInfo>),
  updatesRefresh: (password: string) =>
    fetch("/api/updates/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    }).then(j<{ accepted: boolean; job: UpdateJob }>),
  updatesInstall: (password: string) =>
    fetch("/api/updates/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    }).then(j<{ accepted: boolean; job: UpdateJob }>),
  updatesJob: () => fetch("/api/updates/job").then(j<UpdateJob>),
  updatesCancel: () => fetch("/api/updates/cancel", { method: "POST" }).then(j<{ cancelling: boolean }>),

  logs: (source: string, lines = 400) =>
    fetch(`/api/logs?source=${source}&lines=${lines}`).then(
      j<{ source: string; label: string; text: string }>,
    ),

  disk: () => fetch("/api/disk").then(j<DiskInfo>),
  diskDelete: (model_id: string) =>
    fetch("/api/disk/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model_id }),
    }).then(j<{ deleted: string }>),
  diskClean: () => fetch("/api/disk/clean", { method: "POST" }).then(j<{ cleaned: boolean }>),

  importInspect: (repo: string) =>
    fetch("/api/import/inspect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo }),
    }).then(j<InspectResp>),
  createModel: (recipe: Recipe) =>
    fetch("/api/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(recipe),
    }).then(j<{ created: string; models: Model[] }>),
  importDownload: (repo: string) =>
    fetch("/api/import/download", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo }),
    }).then(j<{ accepted: boolean; download: DownloadJob }>),
  importStatus: () => fetch("/api/import/status").then(j<DownloadJob>),
  modelEnv: (id: string) =>
    fetch(`/api/models/${id}/env`).then(j<{ id: string; path: string; env: string; repo: string; source: string }>),
  saveModelEnv: (id: string, text: string) =>
    fetch(`/api/models/${id}/env`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }).then(j<{ saved: string; models: Model[] }>),
  modelHfLookup: (id: string) => fetch(`/api/models/${id}/hf-lookup`).then(j<HfLookup>),
  deleteModel: (id: string, weights = false) =>
    fetch(`/api/models/${id}?weights=${weights ? 1 : 0}`, { method: "DELETE" }).then(
      j<{ deleted: string; models: Model[] }>,
    ),
  promoteModel: (id: string) =>
    fetch(`/api/models/${id}/promote`, { method: "POST" }).then(j<{ promoted: string; models: Model[] }>),
};
