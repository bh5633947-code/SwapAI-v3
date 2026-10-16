"use client";

import { useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { Film, ImageIcon, UploadCloud, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface UploadDropzoneProps {
  kind: "image" | "video";
  title: string;
  hint: string;
  previewUrl?: string;
  disabled?: boolean;
  onSelect: (file: File) => void;
  onClear: () => void;
}

const ACCEPT: Record<UploadDropzoneProps["kind"], string> = {
  image: "image/jpeg,image/png",
  video: "video/mp4,video/quicktime,video/x-msvideo,.mp4,.mov,.avi",
};

export function UploadDropzone({ kind, title, hint, previewUrl, disabled, onSelect, onClear }: UploadDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const Icon = kind === "image" ? ImageIcon : Film;
  const hasPreview = Boolean(previewUrl);

  function openPicker() {
    if (!disabled && !hasPreview) inputRef.current?.click();
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    if (disabled) return;
    const file = e.dataTransfer.files?.[0];
    if (file) onSelect(file);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openPicker();
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Icon className="h-4 w-4 text-primary" />
        {title}
      </div>

      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        onClick={openPicker}
        onKeyDown={handleKeyDown}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={cn(
          "group relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed border-border bg-card/60 transition-colors",
          !hasPreview && !disabled && "cursor-pointer hover:border-primary/60 hover:bg-primary/5",
          hasPreview && "border-solid",
          dragging && "border-primary bg-primary/10",
          disabled && "opacity-70",
        )}
      >
        {hasPreview && kind === "image" && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={previewUrl} alt="Pré-visualização da imagem enviada" className="h-full w-full bg-black/40 object-contain" />
        )}

        {hasPreview && kind === "video" && (
          <video src={previewUrl} controls playsInline className="h-full w-full bg-black object-contain" />
        )}

        {!hasPreview && (
          <div className="flex flex-col items-center gap-2 p-6 text-center">
            <UploadCloud className="h-10 w-10 text-muted-foreground transition-colors group-hover:text-primary" />
            <p className="text-sm font-medium">Arraste ou clique para enviar</p>
            <p className="text-xs text-muted-foreground">{hint}</p>
          </div>
        )}

        {hasPreview && !disabled && (
          <button
            type="button"
            aria-label="Remover arquivo"
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
            className="absolute right-2 top-2 rounded-full bg-black/70 p-1.5 text-white transition-colors hover:bg-black"
          >
            <X className="h-4 w-4" />
          </button>
        )}

        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT[kind]}
          className="hidden"
          disabled={disabled}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onSelect(file);
            e.target.value = ""; // permite selecionar o mesmo arquivo novamente
          }}
        />
      </div>
    </div>
  );
}
