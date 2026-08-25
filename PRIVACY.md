# Privacy

Codex Panel is a local-first application. Its desktop launcher runs the
Panel service on the local computer and does not send Panel content or
usage telemetry to the project maintainers.

## Data stored on the computer

On Windows, Codex Panel stores its database, attachments, launcher runtime
file, and independent Codex browser profile under:

`%APPDATA%\Codex Panel`

Launcher logs are stored under:

`%LOCALAPPDATA%\Codex Panel\Logs`

The launcher also installs the bundled `manage-panel` Skill in the current
user's `.agents\skills\manage-panel` directory.

## Network activity

- The desktop app uses a loopback-only HTTP service to connect the embedded
  panel, the launcher, and `panelctl` on the same computer.
- The desktop app checks the Fork's GitHub Releases endpoint for available
  versions and opens the validated Release page; it does not automatically
  download or install updates.
- The official Codex application and Codex CLI use OpenAI services under the
  user's existing OpenAI account and OpenAI's terms.
- Cloud collaboration is optional. When a user configures it, Panel data is
  sent to the deployment selected by that user.

Codex Panel does not include advertising or a project-maintainer analytics
service.

## Removing data

Uninstalling the Windows application removes the installed program but keeps
user data and the installed Skill. See
[Windows uninstall](docs/windows-uninstall.md) for the optional manual cleanup.
