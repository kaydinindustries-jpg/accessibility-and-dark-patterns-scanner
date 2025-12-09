"use client";
import { useEffect, useMemo, useState } from "react";

interface ScanItem {
  id: string;
  status: string;
  createdAt: string;
  metrics: { global: number | null; perceivable: number | null; operable: number | null; understandable: number | null; robust: number | null };
  majors: number;
}

function Sparkline({ values }: { values: (number | null)[] }) {
  const data = values.filter((v): v is number => typeof v === "number");
  const min = Math.min(...data, 0);
  const max = Math.max(...data, 100);
  const points = data.map((v, i) => `${(i / Math.max(1, data.length - 1)) * 100},${100 - ((v - min) / Math.max(1, max - min)) * 100}`).join(" ");
  return (
    <svg width="200" height="40" viewBox="0 0 100 100" aria-label="sparkline" role="img" style={{ background: "#fff", border: "1px solid #eee" }}>
      <polyline points={points} fill="none" stroke="#0ea5e9" strokeWidth="2" />
    </svg>
  );
}

function ScoreBadge({ label, value }: { label: string; value: number | null }) {
  const color = value == null ? "#9ca3af" : value >= 90 ? "#16a34a" : value >= 75 ? "#f59e0b" : "#dc2626";
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 8px", borderRadius: 8, border: "1px solid #e5e7eb" }}>
      <span style={{ fontSize: 12, color: "#6b7280" }}>{label}</span>
      <span style={{ fontWeight: 700, color }}>{value == null ? "–" : Math.round(value)}</span>
    </div>
  );
}

export default function SitePage({ params }: { params: { id: string } }) {
  const initialId = decodeURIComponent(params?.id || "test-site");
  const [siteId, setSiteId] = useState(initialId);
  const [items, setItems] = useState<ScanItem[]>([]);
  const [selectedScanId, setSelectedScanId] = useState<string | null>(null);
  const [diff, setDiff] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [user, setUser] = useState<null | { id?: string; email?: string }>(null);
  const [orgId, setOrgId] = useState<string>("test-org");
  // Billing states
  const [billing, setBilling] = useState<null | { orgId: string; free?: boolean; subscription: null | { status?: string; current_period_end?: string; price_id?: string | null; qty?: number | null } }>(null);
  const [billingLoading, setBillingLoading] = useState<boolean>(false);
  // Auth notice state
  const [authRequired, setAuthRequired] = useState<boolean>(false);
  const api = ""; // use Next.js rewrite to /api
  const AUTH_ENABLED = process.env.NEXT_PUBLIC_AUTH_ENABLED === "1" || process.env.NEXT_PUBLIC_AUTH_ENABLED === "true";

  useEffect(() => {
    // Load orgId from localStorage and current user from backend
    try {
      const stored = typeof window !== "undefined" ? window.localStorage.getItem("orgId") : null;
      if (stored) setOrgId(stored);
    } catch {}

    async function loadUser() {
      try {
        if (!AUTH_ENABLED) { setUser(null); return; }
        const r = await fetch(`${api}/api/auth/me`, { headers: { "cache-control": "no-cache" }, credentials: 'include' });
        if (r.ok) {
          const j = await r.json();
          setUser(j.user);
        } else {
          // Auth disabled or not available
          setUser(null);
        }
      } catch {
        setUser(null);
      }
    }
    loadUser();
  }, []);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const r = await fetch(`${api}/api/sites/${encodeURIComponent(siteId)}/scans?limit=50&orgId=${encodeURIComponent(orgId)}`, {
          headers: { "x-org-id": orgId },
          credentials: 'include',
        });
        if (!r.ok) {
          if (r.status === 401) setAuthRequired(true);
          const text = await r.text();
          console.error("failed_list_scans_status", r.status, text.slice(0, 200));
          setItems([]);
          setSelectedScanId(null);
          return;
        }
        const j = await r.json();
        setItems(j.items || []);
        const defaultId = (j.items?.[0]?.id as string | undefined) || null;
        setSelectedScanId(defaultId);
      } catch (e) {
        console.error("failed_list_scans", e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [siteId, orgId]);

  useEffect(() => {
    async function loadDiff() {
      if (!selectedScanId) { setDiff(null); return; }
      try {
        const r = await fetch(`${api}/api/scans/${encodeURIComponent(selectedScanId)}/diff?orgId=${encodeURIComponent(orgId)}`, {
          headers: { "x-org-id": orgId },
          credentials: 'include',
        });
        if (!r.ok) {
          if (r.status === 401) setAuthRequired(true);
          const text = await r.text();
          console.error("failed_get_diff_status", r.status, text.slice(0, 200));
          setDiff(null);
          return;
        }
        const j = await r.json();
        setDiff(j);
      } catch (e) {
        console.error("failed_get_diff", e);
      }
    }
    loadDiff();
  }, [selectedScanId, orgId]);

  // Billing status loader
  useEffect(() => {
    async function loadBilling() {
      setBillingLoading(true);
      try {
        const r = await fetch(`${api}/api/billing/status?orgId=${encodeURIComponent(orgId)}`, { credentials: 'include' });
        if (!r.ok) {
          if (r.status === 401) setAuthRequired(true);
          const txt = await r.text();
          console.warn("billing_status_error", r.status, txt.slice(0, 200));
          setBilling(null);
          return;
        }
        const j = await r.json();
        setBilling(j);
      } catch (e) {
        console.warn("billing_status_failed", e);
        setBilling(null);
      } finally {
        setBillingLoading(false);
      }
    }
    loadBilling();
  }, [orgId]);

  const sparkValues = useMemo(() => items.map(it => it.metrics.global), [items]);

  const login = (provider: "google" | "microsoft") => {
    window.location.href = `${api}/api/auth/login/${provider}`;
  };
  const logout = async () => {
    try {
      await fetch(`${api}/api/auth/logout`, { method: "POST", credentials: 'include' });
    } finally {
      window.location.reload();
    }
  };
  const persistOrg = () => {
    try { window.localStorage.setItem("orgId", orgId); } catch {}
  };

  const PRICE_PRO = process.env.NEXT_PUBLIC_STRIPE_PRICE_PRO_29;
  const PRICE_TEAM = process.env.NEXT_PUBLIC_STRIPE_PRICE_TEAM_49;
  const checkout = async (priceId?: string) => {
    try {
      const r = await fetch(`${api}/api/billing/checkout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: 'include',
        body: JSON.stringify({ orgId, ...(priceId ? { priceId } : {}) }),
      });
      if (!r.ok) {
        if (r.status === 403) {
          const txt = await r.text();
          if (txt.includes("free_mode")) {
            alert("Le mode gratuit est activé: la facturation est désactivée.");
            return;
          }
        }
        const txt = await r.text();
        alert(`Impossible de créer la session de paiement: ${r.status} - ${txt.slice(0, 200)}`);
        return;
      }
      const j = await r.json();
      if (j?.url) {
        window.location.href = j.url;
      } else {
        alert("Réponse inattendue du serveur de paiement.");
      }
    } catch (e) {
      alert("Erreur lors de l'initialisation du paiement.");
      console.error(e);
    }
  };

  const sub = billing?.subscription || null;
  const subActive = !!(sub && sub.status === "active" && (!sub.current_period_end || new Date(sub.current_period_end).getTime() > Date.now()));
  const subUntil = sub?.current_period_end ? new Date(sub.current_period_end) : null;
  const free = billing?.free === true;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", justifyContent: "space-between", padding: 12, border: "1px solid #e5e7eb", borderRadius: 8, background: "#fff" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <strong>Organisation:</strong>
          <input value={orgId} onChange={e => setOrgId(e.target.value)} placeholder="org id" style={{ padding: 6, border: "1px solid #e5e7eb", borderRadius: 6 }} />
          {/* Bouton thème foncé */}
          <button onClick={persistOrg} style={{ padding: "6px 10px", border: "1px solid #1f2937", borderRadius: 6, background: "#1f2937", color: "#fff" }}>Appliquer</button>
        </div>
        <div>
          {user ? (
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ color: "#6b7280" }}>Connecté: {user.email}</span>
              <button onClick={logout} style={{ padding: "6px 10px", border: "1px solid #e5e7eb", borderRadius: 6, background: "#fee2e2", color: "#991b1b" }}>Se déconnecter</button>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {AUTH_ENABLED ? (
                <>
                  <button onClick={() => login("google")} style={{ padding: "6px 10px", border: "1px solid #111827", borderRadius: 6, background: "#111827", color: "#fff" }}>Se connecter avec Google</button>
                  <button onClick={() => login("microsoft")} style={{ padding: "6px 10px", border: "1px solid #111827", borderRadius: 6, background: "#111827", color: "#fff" }}>Se connecter avec Microsoft</button>
                </>
              ) : (
                <span style={{ color: "#6b7280" }}>Authentification désactivée</span>
              )}
            </div>
          )}
        </div>
      </div>

      {authRequired && AUTH_ENABLED && !user && (
        <div style={{ gridColumn: "1 / -1", marginTop: -8, marginBottom: 8, padding: 12, border: "1px solid #fde68a", borderRadius: 8, background: "#fffbeb", color: "#92400e" }}>
          L'authentification est requise pour accéder aux scans et à la facturation. Veuillez vous connecter ci-dessus.
        </div>
      )}

      {/* Bandeau de facturation */}
      <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: 12, border: "1px solid #e5e7eb", borderRadius: 8, background: free ? "#eff6ff" : (subActive ? "#ecfdf5" : "#fff7ed") }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {billingLoading ? (
            <span style={{ color: "#6b7280" }}>Chargement de l'état de l'abonnement...</span>
          ) : free ? (
            <span style={{ color: "#1e40af", fontWeight: 600 }}>Mode Gratuit activé — la facturation est désactivée et toutes les fonctionnalités sont accessibles.</span>
          ) : subActive ? (
            <span style={{ color: "#065f46", fontWeight: 600 }}>Abonnement actif {subUntil ? `jusqu'au ${subUntil.toLocaleDateString()} ${subUntil.toLocaleTimeString()}` : ''}</span>
          ) : (
            <span style={{ color: "#92400e", fontWeight: 600 }}>Aucun abonnement actif pour cette organisation. Souscrivez pour activer les planifications.</span>
          )}
          {sub && !subActive && !free ? (
            <span style={{ color: "#92400e" }}>Statut: {sub.status}</span>
          ) : null}
        </div>
        {!free && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={() => checkout(PRICE_PRO || undefined)} style={{ padding: "8px 12px", border: "1px solid #111827", borderRadius: 6, background: "#111827", color: "#fff" }}>Souscrire Pro (29€)</button>
            <button onClick={() => checkout(PRICE_TEAM)} disabled={!PRICE_TEAM} title={!PRICE_TEAM ? "Définissez NEXT_PUBLIC_STRIPE_PRICE_TEAM_49 pour activer" : undefined} style={{ padding: "8px 12px", border: "1px solid #1f2937", borderRadius: 6, background: PRICE_TEAM ? "#1f2937" : "#9ca3af", color: "#fff" }}>Team (49€)</button>
          </div>
        )}
      </div>

      <section>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Site: {siteId}</h2>
          <Sparkline values={sparkValues} />
        </div>

        <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#f3f4f6" }}>
                <th style={{ textAlign: "left", padding: 8 }}>Date</th>
                <th style={{ textAlign: "left", padding: 8 }}>Statut</th>
                <th style={{ textAlign: "left", padding: 8 }}>Scores</th>
                <th style={{ textAlign: "left", padding: 8 }}>Majors</th>
                <th style={{ textAlign: "left", padding: 8 }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {items.map(it => (
                <tr key={it.id} style={{ borderTop: "1px solid #e5e7eb" }}>
                  <td style={{ padding: 8 }}>{new Date(it.createdAt).toLocaleString()}</td>
                  <td style={{ padding: 8 }}>{it.status}</td>
                  <td style={{ padding: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <ScoreBadge label="Global" value={it.metrics.global} />
                    <ScoreBadge label="P" value={it.metrics.perceivable} />
                    <ScoreBadge label="O" value={it.metrics.operable} />
                    <ScoreBadge label="U" value={it.metrics.understandable} />
                    <ScoreBadge label="R" value={it.metrics.robust} />
                  </td>
                  <td style={{ padding: 8 }}>{it.majors}</td>
                  <td style={{ padding: 8 }}>
                    <button onClick={() => setSelectedScanId(it.id)} style={{ padding: "6px 10px", border: "1px solid #9ca3af", borderRadius: 6, background: selectedScanId === it.id ? "#4f46e5" : "#f3f4f6", color: selectedScanId === it.id ? "#fff" : "#111" }}>Voir diff</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 style={{ marginTop: 0 }}>Diff pour le scan sélectionné</h2>
        {selectedScanId == null ? (
          <p>Sélectionnez un scan pour voir son diff.</p>
        ) : diff == null ? (
          <p>Chargement du diff...</p>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div>
              <h3>Résumé</h3>
              <ul>
                <li>Nouveaux: {diff.summary?.new ?? 0}</li>
                <li>Résolus: {diff.summary?.resolved ?? 0}</li>
                <li>Régressions: {diff.summary?.regressions ?? 0}</li>
                <li>Majors: {diff.summary?.newMajors ?? 0}</li>
              </ul>
            </div>
            <div>
              <h3>Par principe</h3>
              <ul>
                {Object.entries(diff.summary?.byPrinciple || {}).map(([p, v]: any) => (
                  <li key={p}>{p}: +{(v as any).new} / -{(v as any).resolved} / ↗︎{(v as any).regressions}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3>Nouveaux problèmes</h3>
              <ul>
                {diff.newIssues?.map((x: any, i: number) => (
                  <li key={i}>{x.ruleId} ({x.sc || ""}) — {x.impact} — {x.principle}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3>Résolus</h3>
              <ul>
                {diff.resolvedIssues?.map((x: any, i: number) => (
                  <li key={i}>{x.ruleId} ({x.sc || ""}) — {x.impact} — {x.principle}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3>Régressions</h3>
              <ul>
                {diff.regressions?.map((x: any, i: number) => (
                  <li key={i}>{x.ruleId} ({x.sc || ""}) — {x.from} → {x.to} — {x.principle}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}