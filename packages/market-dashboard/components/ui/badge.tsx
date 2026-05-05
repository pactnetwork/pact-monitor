import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "react";

type Variant = "ok" | "timeout" | "error" | "neutral";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: Variant;
}

const variantClasses: Record<Variant, string> = {
  ok: "bg-[#1a2a22] text-[#5A6B7A] border-[#2a3a32]",
  timeout: "bg-[#2a1a14] text-[#C9553D] border-[#3a2a24]",
  error: "bg-[#2a1a14] text-[#C9553D] border-[#3a2a24]",
  neutral: "bg-[#2a2420] text-[#8a7a70] border-[#3a3430]",
};

export function Badge({ className, variant = "neutral", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-block px-2 py-0.5 text-xs font-mono border uppercase",
        variantClasses[variant],
        className
      )}
      {...props}
    />
  );
}
