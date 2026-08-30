"use client";

import { useEffect, useState } from "react";
import { api, type AdminUser, type Role, type ModelProviderStatusResult } from "../../../lib/api";

function statusTone(status: string) {
  if (status === "available") return "completed";
  if (status === "degraded") return "running";
  if (status === "unavailable") return "failed";
  return "cancelled"; // not_configured / disabled
}

export default function AdminPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersError, setUsersError] = useState("");
  const [usersLoading, setUsersLoading] = useState(true);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("OPERATOR");
  const [creating, setCreating] = useState(false);

  const [providerStatus, setProviderStatus] = useState<ModelProviderStatusResult | null>(null);
  const [providerError, setProviderError] = useState("");
  const [providerLoading, setProviderLoading] = useState(true);

  function refreshUsers() {
    setUsersError("");
    api.getUsers().then((d) => setUsers(d.users)).catch((err) => setUsersError(err instanceof Error ? err.message : "Failed to load users (requires global admin)")).finally(() => setUsersLoading(false));
  }

  function refreshProviders() {
    setProviderLoading(true);
    setProviderError("");
    api.getModelProviderStatus().then(setProviderStatus).catch((err) => setProviderError(err instanceof Error ? err.message : "Failed to load provider status")).finally(() => setProviderLoading(false));
  }

  useEffect(() => { refreshUsers(); refreshProviders(); }, []);

  async function handleCreateUser() {
    if (!email.trim() || password.length < 12) return;
    setCreating(true);
    setUsersError("");
    try {
      await api.createUser(email.trim(), password, role);
      setEmail(""); setPassword(""); setRole("OPERATOR");
      refreshUsers();
    } catch (err) { setUsersError(err instanceof Error ? err.message : "Failed to create user"); } finally { setCreating(false); }
  }

  async function handleDisable(userId: string) {
    if (!confirm("Disable this user? Their sessions will be revoked immediately.")) return;
    try { await api.disableUser(userId); refreshUsers(); } catch (err) { setUsersError(err instanceof Error ? err.message : "Failed to disable user"); }
  }

  return (
    <div className="stub-page" style={{ padding: 32, maxWidth: 1100, display: "flex", flexDirection: "column", gap: 32 }}>
      <div>
        <h1>Admin</h1>
        <p className="text-muted">User accounts and model provider health. Requires a global administrator account.</p>
      </div>

      <section>
        <div className="section-title">Create user</div>
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="row-gap">
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@example.com" className="field-input" style={{ width: 240 }} />
            <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password (min 12 chars)" type="password" className="field-input" style={{ width: 220 }} />
            <select value={role} onChange={(e) => setRole(e.target.value as Role)} className="field-input" style={{ width: 140 }}>
              <option value="OPERATOR">Operator</option>
              <option value="REVIEWER">Reviewer</option>
              <option value="ADMIN">Admin</option>
            </select>
            <button onClick={handleCreateUser} disabled={creating || !email.trim() || password.length < 12} className="btn-primary">Create</button>
          </div>
        </div>

        {usersError && <p className="error">{usersError}</p>}
        {usersLoading ? (
          <p className="text-muted">Loading…</p>
        ) : (
          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--line)", textAlign: "left" }}>
                  {["Email", "Role", "Status", "Created", ""].map((h) => (
                    <th key={h} style={{ padding: "10px 14px", color: "var(--ink-3)", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} style={{ borderBottom: "1px solid var(--line)" }}>
                    <td style={{ padding: "10px 14px", color: "var(--ink)" }}>{u.email}</td>
                    <td style={{ padding: "10px 14px" }}><span className="chip">{u.role}</span></td>
                    <td style={{ padding: "10px 14px" }}>
                      <span className={`status status-${u.disabledAt ? "cancelled" : "completed"}`}>{u.disabledAt ? "Disabled" : "Active"}</span>
                    </td>
                    <td style={{ padding: "10px 14px", color: "var(--ink-3)" }}>{new Date(u.createdAt).toLocaleString()}</td>
                    <td style={{ padding: "10px 14px" }}>
                      {!u.disabledAt && <button onClick={() => handleDisable(u.id)} className="btn-danger" style={{ padding: "4px 8px", fontSize: 11 }}>Disable</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <div className="row-gap" style={{ justifyContent: "space-between", marginBottom: 6 }}>
          <div className="section-title" style={{ margin: 0 }}>Model provider status</div>
          <button onClick={refreshProviders} className="btn-ghost" style={{ fontSize: 12 }}>Refresh</button>
        </div>
        {providerError && <p className="error">{providerError}</p>}
        {providerLoading ? (
          <p className="text-muted">Probing providers…</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {providerStatus?.providers.map((p) => (
              <div key={p.providerId} className="card" style={{ gap: 10 }}>
                <div className="row-gap" style={{ justifyContent: "space-between" }}>
                  <div className="row-gap">
                    <span style={{ fontFamily: "monospace", fontSize: 13, color: "var(--ink)" }}>{p.providerId}</span>
                    <span className="chip">{p.location}</span>
                  </div>
                  <div className="row-gap">
                    {p.latencyMs !== undefined && <span className="text-muted">{p.latencyMs}ms</span>}
                    <span className={`status status-${statusTone(p.status)}`}>{p.status.replace("_", " ")}</span>
                  </div>
                </div>
                <div className="row-gap">
                  {p.profiles.map((profile) => (
                    <span key={profile.profileId} className="chip" style={{ color: profile.available === false ? "var(--red)" : profile.available === true ? "var(--green)" : "var(--ink-3)" }}>
                      {profile.profileId} ({profile.capabilities.join(", ")})
                    </span>
                  ))}
                </div>
              </div>
            ))}
            {providerStatus && <p className="text-muted">Checked {new Date(providerStatus.checkedAt).toLocaleString()}</p>}
          </div>
        )}
      </section>
    </div>
  );
}
