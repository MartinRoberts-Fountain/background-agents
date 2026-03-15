"""Tests for SandboxSupervisor._setup_gh_cli()."""

import os
from unittest.mock import patch
from src.sandbox.entrypoint import SandboxSupervisor


def _make_supervisor(env_overrides: dict[str, str] | None = None) -> SandboxSupervisor:
    """Create a SandboxSupervisor with controlled env vars."""
    base_env = {
        "SANDBOX_ID": "test-sandbox",
        "CONTROL_PLANE_URL": "https://cp.example.com",
        "SANDBOX_AUTH_TOKEN": "tok",
        "REPO_OWNER": "acme",
        "REPO_NAME": "app",
        "VCS_HOST": "github.com",
        "VCS_CLONE_USERNAME": "x-access-token",
        "VCS_CLONE_TOKEN": "dummy_token_abc123",
    }
    if env_overrides:
        base_env.update(env_overrides)
    with patch.dict("os.environ", base_env, clear=True):
        return SandboxSupervisor()


def _hosts_file(tmp_path):
    """Return the expected hosts.yml path under tmp_path."""
    return tmp_path / ".config" / "gh" / "hosts.yml"


class TestGhCliSetup:
    """Cases for _setup_gh_cli()."""

    def test_writes_hosts_yml_when_github_and_token_present(self, tmp_path):
        sup = _make_supervisor()

        with patch("pathlib.Path.home", return_value=tmp_path):
            sup._setup_gh_cli()

        assert _hosts_file(tmp_path).exists()
        content = _hosts_file(tmp_path).read_text()
        assert "github.com:" in content
        assert "user: x-access-token" in content
        assert "oauth_token: dummy_token_abc123" in content
        assert "git_protocol: https" in content

    def test_skips_when_not_github(self, tmp_path):
        sup = _make_supervisor({"VCS_HOST": "bitbucket.org"})

        with patch("pathlib.Path.home", return_value=tmp_path):
            sup._setup_gh_cli()

        assert not _hosts_file(tmp_path).exists()

    def test_skips_when_no_token(self, tmp_path):
        sup = _make_supervisor({"VCS_CLONE_TOKEN": ""})

        with patch("pathlib.Path.home", return_value=tmp_path):
            sup._setup_gh_cli()

        assert not _hosts_file(tmp_path).exists()

    def test_sets_secure_permissions(self, tmp_path):
        sup = _make_supervisor()

        with patch("pathlib.Path.home", return_value=tmp_path):
            sup._setup_gh_cli()

        mode = _hosts_file(tmp_path).stat().st_mode & 0o777
        assert mode == 0o600

    def test_does_not_crash_on_write_failure(self, tmp_path):
        sup = _make_supervisor()

        with (
            patch("pathlib.Path.home", return_value=tmp_path),
            patch("os.open", side_effect=OSError("disk full")),
        ):
            sup._setup_gh_cli()
