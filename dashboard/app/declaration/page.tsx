"use client";
import { useEffect, useMemo, useState } from "react";

interface ScanItem {
  id: string;
  status: string;
  createdAt: string;
  metrics: { global: number | null; perceivable: number | null; operable: number | null; understandable: number | null; robust: number | null };
  majors: number;
}

export default function DeclarationPage() {
  const [orgId, setOrgId] = useState("");
  const [siteId, setSiteId] = useState("");
  const [scans, setScans] = useState<ScanItem[]>([]);
  const [selectedScanId, setSelectedScanId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [resultUrl, setResultUrl] = useState<string>("");
  const [error, setError] = useState<string>("");

  const api = ""; // Next.js rewrite to /api -> scanner

  useEffect(() => {
    if (!orgId || !siteId) { setScans([]); setSelectedScanId(""); return; }
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const r = await fetch(`${api}/api/sites/${encodeURIComponent(siteId)}/scans?limit=50&orgId=${encodeURIComponent(orgId)}`, { credentials: 'include' });
        if (!r.ok) {
          const text = await r.text();
          console.error("failed_list_scans_status", r.status, text.slice(0, 200));
          if (!cancelled) { setScans([]); setSelectedScanId(""); setError(`Erreur chargement scans: ${r.status}`); }
          return;
        }
        const j = await r.json();
        const items: ScanItem[] = j.items || [];
        if (!cancelled) {
          setScans(items);
          setSelectedScanId(items[0]?.id || "");
        }
      } catch (e: any) {
        console.error("failed_list_scans", e);
        if (!cancelled) setError("Échec de chargement des scans");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [orgId, siteId]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    setResultUrl("");
    try {
      if (!orgId) throw new Error("orgId requis");
      if (!selectedScanId) throw new Error("scanId requis");
      const r = await fetch(`${api}/api/scans/${encodeURIComponent(selectedScanId)}/declaration?orgId=${encodeURIComponent(orgId)}` , { method: 'POST', credentials: 'include' });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`Echec génération: ${r.status} ${text.slice(0,200)}`);
      }
      const j = await r.json();
      const url = j.url as string | undefined;
      const filename = j.filename as string | undefined;
      if (url) {
        setResultUrl(url);
      } else if (filename) {
        // Base URL non configurée côté scanner, proposer le téléchargement direct via endpoint artifacts
        setResultUrl(`${api}/api/scans/${encodeURIComponent(selectedScanId)}/artifacts/${encodeURIComponent(filename)}?orgId=${encodeURIComponent(orgId)}`);
      } else {
        setError("Réponse inattendue de l'API");
      }
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = useMemo(() => !!orgId && !!selectedScanId, [orgId, selectedScanId]);

  return (
    <div>
      <h1>Générer une déclaration (DOCX)</h1>
      <p>Créez une déclaration d’accessibilité au format DOCX basée sur un scan terminé. Le lien signé expire sous 24 heures.</p>

      <form onSubmit={onSubmit} style={{ display: 'grid', gap: 12, maxWidth: 640 }}>
        <label style={{ display: 'grid', gap: 6 }}>
          <span>Organisation (orgId)</span>
          <input value={orgId} onChange={e => setOrgId(e.target.value)} placeholder="ex: test-org" style={{ padding: 8, border: '1px solid #e5e7eb', borderRadius: 6 }} />
        </label>
        <label style={{ display: 'grid', gap: 6 }}>
          <span>Site (siteId)</span>
          <input value={siteId} onChange={e => setSiteId(e.target.value)} placeholder="ex: test-site" style={{ padding: 8, border: '1px solid #e5e7eb', borderRadius: 6 }} />
        </label>
        {loading ? (
          <div>Chargement des scans…</div>
        ) : scans.length > 0 ? (
          <label style={{ display: 'grid', gap: 6 }}>
            <span>Scan</span>
            <select value={selectedScanId} onChange={e => setSelectedScanId(e.target.value)} style={{ padding: 8, border: '1px solid #e5e7eb', borderRadius: 6 }}>
              {scans.map(s => (
                <option key={s.id} value={s.id}>{new Date(s.createdAt).toLocaleString()} — {s.status} — Global {s.metrics.global == null ? '–' : Math.round(s.metrics.global)}</option>
              ))}
            </select>
          </label>
        ) : (
          siteId && orgId ? <div>Aucun scan trouvé pour ce site.</div> : null
        )}
        <div>
          <button type="submit" disabled={!canSubmit || submitting} style={{ padding: '10px 14px', borderRadius: 8, border: '1px solid #e5e7eb', background: canSubmit ? '#4f46e5' : '#9ca3af', color: '#fff' }}>
            {submitting ? 'Génération…' : 'Générer la déclaration'}
          </button>
        </div>
      </form>

      {error && (
        <div style={{ marginTop: 16, color: '#b91c1c' }}>{error}</div>
      )}

      {resultUrl && (
        <div style={{ marginTop: 16, padding: 12, border: '1px solid #e5e7eb', borderRadius: 8, background: '#f9fafb' }}>
          <div style={{ marginBottom: 8 }}>Lien de téléchargement (exp. 24h):</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input value={resultUrl} readOnly style={{ flex: 1, padding: 8, border: '1px solid #e5e7eb', borderRadius: 6 }} />
            <a href={resultUrl} target="_blank" rel="noreferrer" style={{ padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff' }}>Ouvrir</a>
            <button onClick={() => navigator.clipboard.writeText(resultUrl)} style={{ padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff' }} type="button">Copier</button>
          </div>
        </div>
      )}
    </div>
  );
}