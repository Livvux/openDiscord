"use client";

import { useState, useTransition } from "react";
import { createCategory, deleteCategory, renameCategory } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CategorySummary } from "@/server/categories";
import { ChannelPermissions } from "@/components/app/channel-permissions";

export function CategoriesEditor({ communityId, categories, canManagePermissions }: { communityId: string; categories: CategorySummary[]; canManagePermissions: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, onOk?: () => void) =>
    startTransition(async () => {
      const result = await fn();
      setError(result.ok ? null : (result.error ?? "Something went wrong."));
      if (result.ok) onOk?.();
    });

  return (
    <div className="grid max-w-xl gap-3">
      {categories.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {categories.map((c) => (
            <li key={c.id} className="px-3 py-2">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = String(new FormData(e.currentTarget).get("name"));
                  run(() => renameCategory(c.id, name));
                }}
                className="flex items-center gap-2"
              >
                <label htmlFor={`category-${c.id}`} className="sr-only">Name of category {c.name}</label>
                <Input id={`category-${c.id}`} name="name" defaultValue={c.name} maxLength={32} required />
                <Button type="submit" variant="outline" size="sm" disabled={pending}>Rename</Button>
                {canManagePermissions && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-expanded={editing === c.id}
                    aria-label={`Permissions of category ${c.name}`}
                    onClick={() => setEditing(editing === c.id ? null : c.id)}
                  >
                    Permissions
                  </Button>
                )}
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={pending}
                  aria-label={`Delete category ${c.name}`}
                  onClick={() => window.confirm(`Delete the category ${c.name}? Its channels stay, without a category.`) && run(() => deleteCategory(c.id))}
                >
                  Delete
                </Button>
              </form>
              {editing === c.id && <div className="mt-2"><ChannelPermissions categoryId={c.id} name={c.name} /></div>}
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const name = String(new FormData(form).get("name"));
          run(() => createCategory(communityId, name), () => form.reset());
        }}
        className="grid gap-1.5"
      >
        <Label htmlFor="new-category">New category</Label>
        <div className="flex gap-2">
          <Input id="new-category" name="name" maxLength={32} required placeholder="e.g. Projects" />
          <Button type="submit" disabled={pending}>Create</Button>
        </div>
      </form>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
