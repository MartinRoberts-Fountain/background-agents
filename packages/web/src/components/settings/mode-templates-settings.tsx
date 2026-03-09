"use client";

import { useState } from "react";
import useSWR, { mutate } from "swr";
import {
  SESSION_MODES,
  SESSION_MODE_LABELS,
  type ModeTemplate,
  type SessionMode,
} from "@open-inspect/shared";
import { Button } from "@/components/ui/button";

const MODE_TEMPLATES_KEY = "/api/mode-templates";

export function ModeTemplatesSettings() {
  const { data, isLoading: loading } = useSWR<{ templates: ModeTemplate[] }>(MODE_TEMPLATES_KEY);
  const [editingMode, setEditingMode] = useState<SessionMode | null>(null);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const templates = data?.templates ?? [];

  const getTemplate = (mode: SessionMode): ModeTemplate | undefined =>
    templates.find((t) => t.mode === mode);

  const startEditing = (mode: SessionMode) => {
    const existing = getTemplate(mode);
    setEditingMode(mode);
    setSystemPrompt(existing?.systemPrompt ?? "");
    setDefaultModel(existing?.defaultModel ?? "");
    setError("");
    setSuccess("");
  };

  const cancelEditing = () => {
    setEditingMode(null);
    setSystemPrompt("");
    setDefaultModel("");
    setError("");
    setSuccess("");
  };

  const handleSave = async () => {
    if (!editingMode) return;

    setSaving(true);
    setError("");
    setSuccess("");

    try {
      const res = await fetch(`/api/mode-templates/${encodeURIComponent(editingMode)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemPrompt,
          defaultModel: defaultModel || null,
        }),
      });

      if (res.ok) {
        mutate(MODE_TEMPLATES_KEY);
        setSuccess(`${SESSION_MODE_LABELS[editingMode]} template saved.`);
        setEditingMode(null);
      } else {
        const data = await res.json();
        setError(data.error || "Failed to save template");
      }
    } catch {
      setError("Failed to save template");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
        Loading mode templates...
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-xl font-semibold text-foreground mb-1">Mode Templates</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Configure the system prompt and default model for each session mode. These settings are used
        when launching sessions in that mode.
      </p>

      {error && (
        <div className="mb-4 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 px-4 py-3 border border-red-200 dark:border-red-800 text-sm">
          {error}
        </div>
      )}

      {success && (
        <div className="mb-4 bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 px-4 py-3 border border-green-200 dark:border-green-800 text-sm">
          {success}
        </div>
      )}

      <div className="space-y-4">
        {SESSION_MODES.map((mode) => {
          const template = getTemplate(mode);
          const isEditing = editingMode === mode;

          if (isEditing) {
            return (
              <div key={mode} className="border border-accent p-4 space-y-3">
                <h3 className="text-sm font-medium text-foreground">{SESSION_MODE_LABELS[mode]}</h3>

                <div>
                  <label className="block text-xs text-muted-foreground mb-1">System Prompt</label>
                  <textarea
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    className="w-full min-h-[120px] bg-transparent border border-border px-3 py-2 text-sm text-foreground focus:outline-none focus:border-accent resize-y"
                    placeholder="Enter the system prompt for this mode..."
                  />
                </div>

                <div>
                  <label className="block text-xs text-muted-foreground mb-1">
                    Default Model (optional)
                  </label>
                  <input
                    type="text"
                    value={defaultModel}
                    onChange={(e) => setDefaultModel(e.target.value)}
                    className="w-full bg-transparent border border-border px-3 py-2 text-sm text-foreground focus:outline-none focus:border-accent"
                    placeholder="e.g. anthropic/claude-sonnet-4-6"
                  />
                </div>

                <div className="flex gap-2">
                  <Button onClick={handleSave} disabled={saving}>
                    {saving ? "Saving..." : "Save"}
                  </Button>
                  <Button onClick={cancelEditing} disabled={saving}>
                    Cancel
                  </Button>
                </div>
              </div>
            );
          }

          return (
            <div
              key={mode}
              className="flex items-center justify-between px-4 py-3 border border-border hover:bg-muted/50 transition"
            >
              <div className="min-w-0">
                <span className="text-sm font-medium text-foreground">
                  {SESSION_MODE_LABELS[mode]}
                </span>
                {template?.systemPrompt ? (
                  <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-md">
                    {template.systemPrompt.slice(0, 100)}
                    {template.systemPrompt.length > 100 ? "..." : ""}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground mt-0.5">No template configured</p>
                )}
                {template?.defaultModel && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Default model: {template.defaultModel}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => startEditing(mode)}
                className="text-xs text-accent hover:text-accent/80 transition flex-shrink-0"
              >
                Configure
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
