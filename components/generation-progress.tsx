import { Loader2 } from "lucide-react";

interface GenerationProgressProps {
  label: string;
  progress: number;
}

export function GenerationProgress({ label, progress }: GenerationProgressProps) {
  const value = Math.max(0, Math.min(100, Math.round(progress)));

  return (
    <div className="rounded-2xl border border-border bg-card/70 p-6 backdrop-blur">
      <div className="flex items-center gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-primary" aria-hidden="true" />
        <p className="font-medium" aria-live="polite">
          {label}
        </p>
        <span className="ml-auto text-sm tabular-nums text-muted-foreground">{value}%</span>
      </div>

      <div
        className="mt-4 h-2 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-violet-500 to-indigo-500 transition-all duration-700 ease-out"
          style={{ width: `${value}%` }}
        />
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        A geração leva alguns minutos. Você pode deixar esta aba aberta.
      </p>
    </div>
  );
}
