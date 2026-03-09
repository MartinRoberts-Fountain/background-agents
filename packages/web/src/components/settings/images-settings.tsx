"use client";

import { useState, useCallback } from "react";
import useSWR, { mutate } from "swr";
import { useRepos } from "@/hooks/use-repos";
import { Button } from "@/components/ui/button";
import { RefreshIcon } from "@/components/ui/icons";
import { formatRelativeTime } from "@/lib/time";

interface RepoImage {
  repo_owner: string;
  repo_name: string;
  status: "building" | "ready" | "failed";
  base_sha: string;
  build_duration_seconds: number;
  error_message?: string;
  created_at: number;
}

interface ImageRegistryData {
  enabledRepos: string[];
  images: RepoImage[];
}

interface Ec2Config {
  setupScript: string | null;
  currentAmiId: string | null;
  status: "idle" | "building" | "failed";
  lastBuiltAt: number | null;
}

const REPO_IMAGES_KEY = "/api/repo-images";
const EC2_CONFIG_KEY = "/api/ec2/config";

export function ImagesSettings() {
  const { repos, loading: reposLoading } = useRepos();
  const { data, isLoading: imagesLoading } = useSWR<ImageRegistryData>(REPO_IMAGES_KEY);
  const [togglingRepos, setTogglingRepos] = useState<Set<string>>(new Set());
  const [triggeringRepos, setTriggeringRepos] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");

  const loading = reposLoading || imagesLoading;

  const enabledRepos = new Set(data?.enabledRepos ?? []);

  const getLatestImage = (owner: string, name: string): RepoImage | undefined => {
    const key = `${owner}/${name}`.toLowerCase();
    return data?.images.find((img) => `${img.repo_owner}/${img.repo_name}`.toLowerCase() === key);
  };

  const handleToggle = async (owner: string, name: string, enabled: boolean) => {
    const repoKey = `${owner}/${name}`.toLowerCase();
    setTogglingRepos((prev) => new Set(prev).add(repoKey));
    setError("");

    try {
      const res = await fetch(
        `/api/repo-images/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/toggle`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        }
      );

      if (!res.ok) {
        const errBody = await res.json();
        setError(errBody.error || "Failed to toggle image build");
      } else {
        mutate(REPO_IMAGES_KEY);
      }
    } catch {
      setError("Failed to toggle image build");
    } finally {
      setTogglingRepos((prev) => {
        const next = new Set(prev);
        next.delete(repoKey);
        return next;
      });
    }
  };

  const handleTrigger = async (owner: string, name: string) => {
    const repoKey = `${owner}/${name}`.toLowerCase();
    setTriggeringRepos((prev) => new Set(prev).add(repoKey));
    setError("");

    try {
      const res = await fetch(
        `/api/repo-images/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/trigger`,
        { method: "POST" }
      );

      if (!res.ok) {
        const errBody = await res.json();
        setError(errBody.error || "Failed to trigger build");
      } else {
        mutate(REPO_IMAGES_KEY);
      }
    } catch {
      setError("Failed to trigger build");
    } finally {
      setTriggeringRepos((prev) => {
        const next = new Set(prev);
        next.delete(repoKey);
        return next;
      });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
        Loading image settings...
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 px-4 py-3 border border-red-200 dark:border-red-800 text-sm">
          {error}
        </div>
      )}

      {/* Modal snapshot images (per-repo) */}
      <div>
        <h2 className="text-xl font-semibold text-foreground mb-1">Pre-Built Images</h2>
        <p className="text-sm text-muted-foreground mb-6">
          Enable pre-built images to speed up sandbox creation. Images are rebuilt automatically
          when the default branch changes.
        </p>

        <div className="space-y-2">
          {repos.map((repo) => {
            const repoKey = `${repo.owner}/${repo.name}`.toLowerCase();
            const isEnabled = enabledRepos.has(repoKey);
            const isToggling = togglingRepos.has(repoKey);
            const isTriggering = triggeringRepos.has(repoKey);
            const image = getLatestImage(repo.owner, repo.name);

            return (
              <div
                key={repo.id}
                className="flex items-center justify-between px-4 py-3 border border-border hover:bg-muted/50 transition"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <label className="relative flex-shrink-0">
                    <input
                      type="checkbox"
                      checked={isEnabled}
                      onChange={() => handleToggle(repo.owner, repo.name, !isEnabled)}
                      disabled={isToggling}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-muted rounded-full peer-checked:bg-accent transition-colors" />
                    <div className="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform peer-checked:translate-x-4" />
                  </label>
                  <span className="text-sm font-medium text-foreground truncate">
                    {repo.owner}/{repo.name}
                  </span>
                </div>

                <div className="flex items-center gap-3 flex-shrink-0 ml-4">
                  <ImageStatus image={image} isEnabled={isEnabled} />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleTrigger(repo.owner, repo.name)}
                    disabled={!isEnabled || isTriggering || image?.status === "building"}
                    title="Rebuild image"
                  >
                    <RefreshIcon className={`w-4 h-4 ${isTriggering ? "animate-spin" : ""}`} />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        {repos.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No repositories found. Install the GitHub App on repositories to get started.
          </p>
        )}
      </div>

      {/* EC2 global AMI config */}
      <Ec2ImageConfig onError={setError} />
    </div>
  );
}

function Ec2ImageConfig({ onError }: { onError: (msg: string) => void }) {
  const { data, isLoading } = useSWR<Ec2Config>(EC2_CONFIG_KEY);
  const [script, setScript] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [saved, setSaved] = useState(false);

  const currentScript = script ?? data?.setupScript ?? "";

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaved(false);
    onError("");

    try {
      const res = await fetch(EC2_CONFIG_KEY, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setupScript: currentScript || null }),
      });

      if (!res.ok) {
        const errBody = await res.json();
        onError(errBody.error || "Failed to save setup script");
      } else {
        mutate(EC2_CONFIG_KEY);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch {
      onError("Failed to save setup script");
    } finally {
      setSaving(false);
    }
  }, [currentScript, onError]);

  const handleTrigger = useCallback(async () => {
    setTriggering(true);
    onError("");

    try {
      const res = await fetch("/api/ec2/trigger", { method: "POST" });

      if (!res.ok) {
        const errBody = await res.json();
        onError(errBody.error || "Failed to trigger EC2 image build");
      } else {
        mutate(EC2_CONFIG_KEY);
      }
    } catch {
      onError("Failed to trigger EC2 image build");
    } finally {
      setTriggering(false);
    }
  }, [onError]);

  return (
    <div>
      <h2 className="text-xl font-semibold text-foreground mb-1">EC2 Image Builder</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Configure a setup script to build a shared EC2 AMI for all EC2 sandbox sessions. The current
        base AMI will boot, run the script, shut down, and a new AMI will be created. Images rebuild
        automatically once a week.
      </p>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
          Loading EC2 config...
        </div>
      ) : (
        <div className="border border-border p-4 space-y-4">
          {/* Current AMI status */}
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Current AMI</span>
            <Ec2Status config={data ?? null} />
          </div>

          {/* Setup script editor */}
          <div>
            <label className="text-sm font-medium text-foreground block mb-1">Setup Script</label>
            <textarea
              value={currentScript}
              onChange={(e) => setScript(e.target.value)}
              placeholder={"#!/bin/bash\n# Install dependencies, configure tools, etc."}
              className="w-full h-40 px-3 py-2 text-sm font-mono bg-background border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent resize-y"
              spellCheck={false}
            />
          </div>

          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : saved ? "Saved" : "Save Script"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleTrigger}
              disabled={triggering || !currentScript || data?.status === "building"}
            >
              {triggering ? "Triggering..." : "Build Now"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Ec2Status({ config }: { config: Ec2Config | null }) {
  if (!config || !config.currentAmiId) {
    return <span className="text-xs text-muted-foreground">No AMI built yet</span>;
  }

  if (config.status === "building") {
    return (
      <div className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse flex-shrink-0" />
        <span className="text-xs text-foreground">Building...</span>
      </div>
    );
  }

  if (config.status === "failed") {
    return (
      <div className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />
        <span className="text-xs text-foreground">Failed</span>
      </div>
    );
  }

  const lastBuilt = config.lastBuiltAt ? formatRelativeTime(config.lastBuiltAt) : "";
  return (
    <div className="text-right">
      <div className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />
        <span className="text-xs text-foreground">
          {config.currentAmiId}
          {lastBuilt ? ` · ${lastBuilt}` : ""}
        </span>
      </div>
    </div>
  );
}

function ImageStatus({ image, isEnabled }: { image: RepoImage | undefined; isEnabled: boolean }) {
  if (!isEnabled) {
    return <span className="text-xs text-muted-foreground">Disabled</span>;
  }

  if (!image) {
    return <span className="text-xs text-muted-foreground">No image</span>;
  }

  if (image.status === "ready") {
    const sha = image.base_sha ? image.base_sha.slice(0, 7) : "";
    const duration = image.build_duration_seconds
      ? `${Math.round(image.build_duration_seconds)}s`
      : "";
    const details = [sha, duration].filter(Boolean).join(" · ");

    return (
      <div className="text-right">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />
          <span className="text-xs text-foreground">
            Ready {formatRelativeTime(image.created_at)}
          </span>
        </div>
        {details && <span className="text-xs text-muted-foreground">{details}</span>}
      </div>
    );
  }

  if (image.status === "building") {
    return (
      <div className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse flex-shrink-0" />
        <span className="text-xs text-foreground">
          Building... {formatRelativeTime(image.created_at)}
        </span>
      </div>
    );
  }

  if (image.status === "failed") {
    return (
      <div className="text-right">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />
          <span className="text-xs text-foreground">Failed</span>
        </div>
        {image.error_message && (
          <span className="text-xs text-muted-foreground truncate max-w-[200px] block">
            {image.error_message}
          </span>
        )}
      </div>
    );
  }

  return null;
}
