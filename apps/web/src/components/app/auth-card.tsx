import { Label } from "@/components/ui/label";
import { Logo } from "@/components/logo";

/** Centered window for sign-in, invites and other standalone pages; same surface as the client preview. */
export function AuthCard({ title, description, children }: { title: string; description?: React.ReactNode; children: React.ReactNode }) {
  return (
    <main className="relative flex flex-1 items-center justify-center p-6">
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-[radial-gradient(rgba(255,255,255,0.06)_1px,transparent_1px)] [background-size:22px_22px]"
      />
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-panel p-8 text-sm shadow-2xl shadow-black/40">
        <Logo />
        <h1 className="mt-6 text-xl font-semibold text-zinc-100">{title}</h1>
        {description && <div className="mt-1 text-muted-foreground">{description}</div>}
        <div className="mt-6">{children}</div>
      </div>
    </main>
  );
}

export function FormError({ children }: { children: React.ReactNode }) {
  return <p role="alert" className="text-sm text-destructive">{children}</p>;
}

export function FormNotice({ children }: { children: React.ReactNode }) {
  return <p role="status" className="text-sm text-success">{children}</p>;
}

export function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}
