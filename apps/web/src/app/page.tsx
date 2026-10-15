import Link from "next/link";

// Placeholder until the marketing site lands.
export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8 text-center">
      <h1 className="text-4xl font-semibold tracking-tight">opendiscord</h1>
      <p className="max-w-md text-zinc-400">
        Open-source community chat. Host it yourself or use opendiscord.app.
      </p>
      <div className="flex gap-3">
        <Link href="/sign-up" className="rounded-md bg-violet-600 px-4 py-2 font-medium hover:bg-violet-500">
          Create account
        </Link>
        <Link href="/sign-in" className="rounded-md border border-zinc-700 px-4 py-2 font-medium hover:bg-zinc-900">
          Sign in
        </Link>
      </div>
    </main>
  );
}
