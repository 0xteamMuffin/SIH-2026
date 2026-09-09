import { useCallback, useEffect, useState } from "react";

import type {
  AdminUser,
  ModelProviderStatus,
  UserRoleName,
  WorkspaceMember,
  WorkspaceSummary,
} from "@shared/types.js";

import { isAuthorisationFailure, useRemoteResource } from "../hooks/useRemoteResource.js";
import { Avatar } from "../components/ui/Avatar.js";
import { Icon } from "../components/ui/Icon.js";
import { IconButton } from "../components/ui/IconButton.js";
import { Select } from "../components/ui/Select.js";

/**
 * Administration.
 *
 * Accounts, workspace membership, and model provider health. Everything here
 * is authorised by the backend, so this view never pre-emptively hides a
 * control based on the signed-in role — it shows the backend's refusal
 * instead. Two copies of an authorisation rule is one copy too many.
 *
 * The backend also enforces invariants the UI deliberately does not duplicate:
 * the last active administrator cannot be disabled, a workspace creator must
 * remain its administrator, and the last workspace administrator cannot be
 * demoted or removed. Those come back as errors with a readable message.
 */

const ROLES: readonly UserRoleName[] = ["ADMIN", "OPERATOR", "REVIEWER"];

const ROLE_OPTIONS = ROLES.map((role) => ({
  value: role,
  label: role.charAt(0) + role.slice(1).toLowerCase(),
}));

/** Matches the backend's minimum, so the failure is caught before the request. */
const MIN_PASSWORD_LENGTH = 12;

export interface AdminViewProps {
  workspaces: WorkspaceSummary[];
  workspaceId: string | null;
}

export function AdminView({ workspaces, workspaceId }: AdminViewProps): React.JSX.Element {
  const users = useRemoteResource(
    useCallback(() => window.workbench.admin.users(), []),
    "admin:users",
  );
  const providers = useRemoteResource(
    useCallback(() => window.workbench.admin.modelProviders(), []),
    "admin:model-providers",
  );

  return (
    <section className="view" aria-label="Administration">
      <header className="view__head">
        <div className="view__titles">
          <h1 className="view__title">Administration</h1>
          <p className="view__subtitle">
            Accounts, workspace membership, and model runtime health.
          </p>
        </div>
        <div className="view__actions">
          <IconButton
            icon="refresh"
            label="Refresh"
            onClick={() => {
              users.reload();
              providers.reload();
            }}
            tooltipAlign="end"
          />
        </div>
      </header>

      <div className="view__body">
        <div className="view__inner">
          <UsersSection users={users} />
          <WorkspacesSection
            workspaces={workspaces}
            initialWorkspaceId={workspaceId}
            users={users.data ?? []}
          />
          <ProvidersSection providers={providers} />
        </div>
      </div>
    </section>
  );
}

// ─── Accounts ────────────────────────────────────────────────────────────────

function UsersSection({
  users,
}: {
  users: ReturnType<typeof useRemoteResource<AdminUser[]>>;
}): React.JSX.Element {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRoleName>("OPERATOR");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const canCreate = email.trim().length > 0 && password.length >= MIN_PASSWORD_LENGTH && !busy;

  function createUser(): void {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    window.workbench.admin
      .createUser(email.trim(), password, role)
      .then(() => {
        setEmail("");
        setPassword("");
        setRole("OPERATOR");
        users.reload();
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  }

  function disableUser(userId: string): void {
    setConfirmingId(null);
    setError(null);
    window.workbench.admin
      .disableUser(userId)
      .then(() => users.reload())
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }

  if (isAuthorisationFailure(users.error)) {
    return (
      <section className="view__section">
        <div className="view__section-head">
          <h2 className="view__section-title">Accounts</h2>
        </div>
        <p className="form-notice">
          <Icon name="lock" size={13} />
          Account administration requires a global administrator. Your workspace-level access is
          unaffected.
        </p>
      </section>
    );
  }

  return (
    <section className="view__section">
      <div className="view__section-head">
        <h2 className="view__section-title">Accounts</h2>
        <p className="view__section-note">
          Disabling an account revokes its sessions immediately. Accounts are never deleted, so the
          audit trail stays intact.
        </p>
      </div>

      <div className="card">
        <div className="card__body">
          <div className="form-row">
            <label className="form-field">
              <span className="form-label">Email</span>
              <input
                className="field"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@organisation.gov"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="form-field">
              <span className="form-label">Password</span>
              <input
                className="field"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                autoComplete="new-password"
              />
            </label>
            <label className="form-field form-field--tight">
              <span className="form-label">Role</span>
              <Select
                value={role}
                options={ROLE_OPTIONS}
                onChange={(next) => setRole(next as UserRoleName)}
                label="Role"
              />
            </label>
            <button
              type="button"
              className="btn btn--primary"
              onClick={createUser}
              disabled={!canCreate}
            >
              {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="plus" size={14} />}
              Create account
            </button>
          </div>

          {password.length > 0 && password.length < MIN_PASSWORD_LENGTH && (
            <p className="form-hint" style={{ marginTop: "var(--space-4)" }}>
              {MIN_PASSWORD_LENGTH - password.length} more characters required.
            </p>
          )}

          {error && (
            <p className="form-error" role="alert" style={{ marginTop: "var(--space-5)" }}>
              <Icon name="alert-circle" size={14} />
              {error}
            </p>
          )}
        </div>

        {users.data && users.data.length > 0 && (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.data.map((user) => (
                  <tr key={user.id} className={user.disabledAt ? "is-dev" : ""}>
                    <td>
                      <span style={{ display: "flex", alignItems: "center", gap: "var(--space-4)" }}>
                        <Avatar name={user.email} size="sm" />
                        <span className="data-table__strong">{user.email}</span>
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${user.role === "ADMIN" ? "badge--accent" : "badge--neutral"}`}>
                        {user.role}
                      </span>
                    </td>
                    <td>
                      {user.disabledAt ? (
                        <span className="badge badge--danger">Disabled</span>
                      ) : (
                        <span className="badge badge--success">Active</span>
                      )}
                    </td>
                    <td className="data-table__mono">{formatDate(user.createdAt)}</td>
                    <td>
                      <span className="data-table__actions">
                        {user.disabledAt ? null : confirmingId === user.id ? (
                          <>
                            <button
                              type="button"
                              className="btn btn--sm btn--danger"
                              onClick={() => disableUser(user.id)}
                            >
                              Disable
                            </button>
                            <IconButton
                              icon="close"
                              label="Keep active"
                              size="sm"
                              hideTooltip
                              onClick={() => setConfirmingId(null)}
                            />
                          </>
                        ) : (
                          <IconButton
                            icon="ban"
                            label={`Disable ${user.email}`}
                            size="sm"
                            tone="danger"
                            onClick={() => setConfirmingId(user.id)}
                            tooltipAlign="end"
                          />
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {users.isLoading && !users.data && (
          <p className="pager">
            <span className="spinner spinner--sm" aria-hidden="true" />
            Loading accounts…
          </p>
        )}
      </div>
    </section>
  );
}

// ─── Workspaces and membership ───────────────────────────────────────────────

function WorkspacesSection({
  workspaces,
  initialWorkspaceId,
  users,
}: {
  workspaces: WorkspaceSummary[];
  initialWorkspaceId: string | null;
  users: AdminUser[];
}): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(initialWorkspaceId);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newWorkspace, setNewWorkspace] = useState("");
  const [addUserId, setAddUserId] = useState("");
  const [addRole, setAddRole] = useState<UserRoleName>("OPERATOR");

  // A workspace created here, or one arriving from the session, should become
  // the selection if nothing is selected yet.
  useEffect(() => {
    setSelectedId((current) => current ?? initialWorkspaceId ?? workspaces[0]?.id ?? null);
  }, [initialWorkspaceId, workspaces]);

  const loadMembers = useCallback((workspaceId: string | null) => {
    if (!workspaceId) {
      setMembers([]);
      return;
    }
    setIsLoading(true);
    setError(null);
    window.workbench.admin
      .workspaceMembers(workspaceId)
      .then(setMembers)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setIsLoading(false));
  }, []);

  useEffect(() => loadMembers(selectedId), [selectedId, loadMembers]);

  function act(operation: Promise<unknown>): void {
    setError(null);
    operation
      .then(() => loadMembers(selectedId))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }

  function createWorkspace(): void {
    const name = newWorkspace.trim();
    if (name.length < 3) return;
    setError(null);
    window.workbench.admin
      .createWorkspace(name)
      .then((workspace) => {
        setNewWorkspace("");
        setSelectedId(workspace.id);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }

  const memberIds = new Set(members.map((member) => member.userId));
  const addable = users.filter((user) => !user.disabledAt && !memberIds.has(user.id));
  const selected = workspaces.find((workspace) => workspace.id === selectedId);

  return (
    <section className="view__section">
      <div className="view__section-head">
        <h2 className="view__section-title">Workspaces and membership</h2>
        <p className="view__section-note">
          A workspace is the unit of isolation: conversations, artifacts, knowledge, and audit
          records all belong to one. Roles here are per-workspace.
        </p>
      </div>

      <div className="card">
        <div className="card__body">
          <div className="form-row">
            <label className="form-field">
              <span className="form-label">New workspace</span>
              <input
                className="field"
                value={newWorkspace}
                onChange={(event) => setNewWorkspace(event.target.value)}
                placeholder="Inspection review"
              />
            </label>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={createWorkspace}
              disabled={newWorkspace.trim().length < 3}
            >
              <Icon name="plus" size={14} />
              Create
            </button>
          </div>
        </div>

        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Workspace</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {workspaces.map((workspace) => (
                <tr key={workspace.id}>
                  <td>
                    <span className="data-table__strong">{workspace.name}</span>{" "}
                    {workspace.id === selectedId && (
                      <span className="badge badge--accent">Viewing</span>
                    )}
                  </td>
                  <td className="data-table__mono">{formatDate(workspace.createdAt)}</td>
                  <td>
                    <span className="data-table__actions">
                      <button
                        type="button"
                        className="btn btn--sm btn--ghost"
                        onClick={() => setSelectedId(workspace.id)}
                      >
                        <Icon name="user" size={12} />
                        Members
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <div className="card">
          <div className="card__head">
            <span className="card__title">Members of {selected.name}</span>
            {isLoading && <span className="spinner spinner--sm" aria-hidden="true" />}
          </div>

          <div className="card__body">
            <div className="form-row">
              <label className="form-field">
                <span className="form-label">Add member</span>
                <Select
                  value={addUserId}
                  options={[
                    { value: "", label: addable.length > 0 ? "Select an account…" : "No accounts available" },
                    ...addable.map((user) => ({ value: user.id, label: user.email })),
                  ]}
                  onChange={setAddUserId}
                  label="Account to add"
                />
              </label>
              <label className="form-field form-field--tight">
                <span className="form-label">Role</span>
                <Select
                  value={addRole}
                  options={ROLE_OPTIONS}
                  onChange={(next) => setAddRole(next as UserRoleName)}
                  label="Member role"
                />
              </label>
              <button
                type="button"
                className="btn btn--primary"
                disabled={!addUserId}
                onClick={() => {
                  act(window.workbench.admin.addMember(selected.id, addUserId, addRole));
                  setAddUserId("");
                }}
              >
                <Icon name="plus" size={14} />
                Add
              </button>
            </div>

            {error && (
              <p className="form-error" role="alert" style={{ marginTop: "var(--space-5)" }}>
                <Icon name="alert-circle" size={14} />
                {error}
              </p>
            )}
          </div>

          {members.length === 0 ? (
            <p className="card__empty">No members yet.</p>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Account role</th>
                    <th>Workspace role</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {members.map((member) => (
                    <tr key={member.userId}>
                      <td>
                        <span
                          style={{ display: "flex", alignItems: "center", gap: "var(--space-4)" }}
                        >
                          <Avatar name={member.user.email} size="sm" />
                          <span className="data-table__strong">{member.user.email}</span>
                        </span>
                      </td>
                      <td>
                        <span className="badge badge--neutral">{member.user.role}</span>
                      </td>
                      <td>
                        <Select
                          value={member.role}
                          options={ROLE_OPTIONS}
                          onChange={(next) =>
                            act(
                              window.workbench.admin.updateMemberRole(
                                selected.id,
                                member.userId,
                                next as UserRoleName,
                              ),
                            )
                          }
                          label={`Workspace role for ${member.user.email}`}
                        />
                      </td>
                      <td>
                        <span className="data-table__actions">
                          <IconButton
                            icon="trash"
                            label={`Remove ${member.user.email}`}
                            size="sm"
                            tone="danger"
                            tooltipAlign="end"
                            onClick={() =>
                              act(window.workbench.admin.removeMember(selected.id, member.userId))
                            }
                          />
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ─── Model runtime health ────────────────────────────────────────────────────

const PROVIDER_BADGES: Record<ModelProviderStatus["status"], string> = {
  available: "badge--success",
  degraded: "badge--warning",
  unavailable: "badge--danger",
  not_configured: "badge--neutral",
  disabled: "badge--neutral",
};

function ProvidersSection({
  providers,
}: {
  providers: ReturnType<typeof useRemoteResource<{ checkedAt: string; providers: ModelProviderStatus[] }>>;
}): React.JSX.Element {
  if (isAuthorisationFailure(providers.error)) {
    return (
      <section className="view__section">
        <div className="view__section-head">
          <h2 className="view__section-title">Model runtime health</h2>
        </div>
        <p className="form-notice">
          <Icon name="lock" size={13} />
          Provider health probes are limited to administrators.
        </p>
      </section>
    );
  }

  return (
    <section className="view__section">
      <div className="view__section-head">
        <h2 className="view__section-title">Model runtime health</h2>
        <p className="view__section-note">
          Live probe of each provider's model list. Off-premise providers are dimmed — see the
          Sovereignty view for what that means.
        </p>
      </div>

      {providers.error ? (
        <p className="form-error" role="alert">
          <Icon name="alert-circle" size={14} />
          {providers.error}
        </p>
      ) : (
        <div className="card">
          {providers.data ? (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Status</th>
                    <th>Capabilities</th>
                    <th className="data-table__numeric">Models up</th>
                    <th className="data-table__numeric">Latency</th>
                  </tr>
                </thead>
                <tbody>
                  {providers.data.providers.map((provider) => {
                    const up = provider.profiles.filter((profile) => profile.available).length;
                    return (
                      <tr
                        key={provider.providerId}
                        className={provider.location === "remote" ? "is-dev" : ""}
                      >
                        <td>
                          <span className="data-table__strong">{provider.providerId}</span>{" "}
                          <span
                            className={`badge ${provider.location === "remote" ? "badge--dev" : "badge--local"}`}
                          >
                            {provider.location === "remote" ? "dev · off-premise" : "on-premise"}
                          </span>
                        </td>
                        <td>
                          <span className={`badge ${PROVIDER_BADGES[provider.status]}`}>
                            {provider.status.replace("_", " ")}
                          </span>
                        </td>
                        <td>{provider.capabilities.join(", ") || "—"}</td>
                        <td className="data-table__numeric">
                          {up} / {provider.profiles.length}
                        </td>
                        <td className="data-table__numeric">
                          {provider.latencyMs === undefined ? "—" : `${provider.latencyMs} ms`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="pager">
              <span className="spinner spinner--sm" aria-hidden="true" />
              Probing providers…
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}
