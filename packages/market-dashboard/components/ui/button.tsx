"use client";
import { cn } from "@/lib/utils";
import { type ButtonHTMLAttributes, forwardRef } from "react";

type Variant = "default" | "copper" | "sienna" | "ghost" | "outline";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variantClasses: Record<Variant, string> = {
  default: "bg-[#2a2420] text-[#f5f0eb] hover:bg-[#3a3430]",
  copper: "bg-[#B87333] text-[#151311] hover:bg-[#a06228]",
  sienna: "bg-[#C9553D] text-[#f5f0eb] hover:bg-[#b04432]",
  ghost: "bg-transparent text-[#f5f0eb] hover:bg-[#2a2420]",
  outline: "bg-transparent border border-[#2a2420] text-[#f5f0eb] hover:bg-[#2a2420]",
};

const sizeClasses: Record<Size, string> = {
  sm: "px-3 py-1 text-sm",
  md: "px-4 py-2 text-sm",
  lg: "px-6 py-3 text-base",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "md", ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center font-mono font-medium transition-colors",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        variantClasses[variant],
        sizeClasses[size],
        className
      )}
      {...props}
    />
  )
);
Button.displayName = "Button";
