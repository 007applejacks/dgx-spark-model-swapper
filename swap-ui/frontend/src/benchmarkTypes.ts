// Types for the new standard benchmark API
export interface BenchmarkConfig {
  serving_requests: number;
  serving_concurrency: number;
  serving_input_len: number;
  serving_output_len: number;
  serving_dataset: string;
  throughput_num_prompts: number;
  throughput_input_len: number;
  throughput_output_len: number;
  eval_tasks: string[];
  eval_limit: number | null;
  eval_batch_size: number;
  timeout_serving: number;
  timeout_throughput: number;
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
  throughput: Record<string, any>;
  throughput_raw: string;
  throughput_error: string | null;
  throughput_passed: boolean;
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
  experimental_cleared: boolean;
  started_at: number | null;
  finished_at: number | null;
  benchmark: BenchmarkResult | null;
  report: BenchmarkResult | null; // same as benchmark for backward compat
}