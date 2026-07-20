// Types for the standard benchmark API.
//
// Two distinct things, kept apart on purpose (see swap-ui/benchmarks.py's module docstring):
// - BenchmarkResult / TestJob: the SAFE suite (serving + eval), both hit the already-running
//   server over HTTP and never disrupt what's loaded. Runs via /api/test.
// - ThroughputResult / ThroughputJob: the offline throughput benchmark. vLLM's own offline
//   throughput benchmark has no remote-server mode — it always loads its own model instance —
//   so running it requires unloading the current model first. Runs via
//   /api/benchmark/throughput, which the UI must gate behind an explicit "this takes the model
//   offline for several minutes" confirmation before calling.
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

export interface BenchmarkResult {
  model_id: string;
  served_name: string;
  timestamp: number;
  config: BenchmarkConfig;
  serving: Record<string, any>;
  serving_raw: string;
  serving_error: string | null;
  serving_passed: boolean;
  evaluation: Record<string, any>;
  evaluation_raw: string;
  evaluation_error: string | null;
  evaluation_passed: boolean;
  gpu_snapshot: Record<string, any>;
  all_passed: boolean;
}

export interface TestJob {
  id: number;
  model_id: string | null;
  served_name: string | null;
  state: "idle" | "running" | "done" | "error";
  phase: "starting" | "serving" | "evaluation" | "complete" | null;
  progress: string | null;
  experimental_cleared: boolean;
  started_at: number | null;
  finished_at: number | null;
  benchmark: BenchmarkResult | null;
  report: BenchmarkResult | null; // same as benchmark for backward compat
}

export interface ThroughputResult {
  model_id: string;
  model_repo: string;
  timestamp: number;
  throughput_num_prompts: number;
  throughput_input_len: number;
  throughput_output_len: number;
  throughput: Record<string, any>;
  throughput_raw: string;
  throughput_error: string | null;
  throughput_passed: boolean;
  gpu_snapshot: Record<string, any>;
}

export interface ThroughputJob {
  id: number;
  model_id: string | null;
  served_name: string | null;
  state: "idle" | "running" | "done" | "error";
  phase: "stopping" | "draining" | "benchmarking" | "reloading" | null;
  progress: string | null;
  reload_ok: boolean | null;
  started_at: number | null;
  finished_at: number | null;
  result: ThroughputResult | Record<string, never>;
}