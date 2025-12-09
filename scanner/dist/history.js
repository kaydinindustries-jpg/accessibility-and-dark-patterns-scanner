function impactWeight(impact) {
    return impact === 'critical' ? 5 : impact === 'serious' ? 3 : impact === 'moderate' ? 2 : impact === 'minor' ? 1 : 1;
}
function ruleToPrinciple(ruleId) {
    if (/color|image|text-alt|contrast|audio|video|time|pause|blink/i.test(ruleId))
        return 'Perceivable';
    if (/keyboard|focus|link|target|timing|gesture|pointer|trap|bypass/i.test(ruleId))
        return 'Operable';
    if (/label|name|language|error|help|instructions|heading|structure/i.test(ruleId))
        return 'Understandable';
    return 'Robust';
}
export async function saveMetricsForScan(pool, scanId, scores) {
    const global = scores.Overall;
    await pool.query(`INSERT INTO scan_metrics (scan_id, global, perceivable, operable, understandable, robust)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (scan_id) DO UPDATE SET global = EXCLUDED.global, perceivable = EXCLUDED.perceivable,
       operable = EXCLUDED.operable, understandable = EXCLUDED.understandable, robust = EXCLUDED.robust`, [scanId, global, scores.Perceivable, scores.Operable, scores.Understandable, scores.Robust]);
}
export async function listScansForSite(pool, siteId, limit, orgId) {
    const params = [siteId, limit];
    const whereOrg = orgId ? ' AND s.org_id = $3' : '';
    if (orgId)
        params.push(orgId);
    const r = await pool.query(`SELECT s.id, s.status, s.created_at,
            COALESCE(m.global, (s.scores->>'Overall')::numeric) as global,
            COALESCE(m.perceivable, (s.scores->>'Perceivable')::numeric) as perceivable,
            COALESCE(m.operable, (s.scores->>'Operable')::numeric) as operable,
            COALESCE(m.understandable, (s.scores->>'Understandable')::numeric) as understandable,
            COALESCE(m.robust, (s.scores->>'Robust')::numeric) as robust,
            (COALESCE((s.counts->>'critical')::int, 0) + COALESCE((s.counts->>'serious')::int, 0)) as majors
     FROM scans s
     LEFT JOIN scan_metrics m ON m.scan_id = s.id
     WHERE s.site_id = $1${whereOrg}
     ORDER BY s.created_at DESC
     LIMIT $2`, params);
    return r.rows.map(row => ({
        id: row.id,
        status: row.status,
        createdAt: row.created_at,
        metrics: {
            global: row.global,
            perceivable: row.perceivable,
            operable: row.operable,
            understandable: row.understandable,
            robust: row.robust,
        },
        majors: row.majors ?? 0,
    }));
}
function keyOf(f) {
    return `${f.rule_id}|${f.sc || ''}`;
}
export async function computeAndPersistDiffForScan(pool, scanId) {
    // Get current scan info
    const scanRes = await pool.query('SELECT site_id, status FROM scans WHERE id = $1 LIMIT 1', [scanId]);
    if (scanRes.rows.length === 0)
        return null;
    const siteId = scanRes.rows[0].site_id;
    // Find previous completed scan for the same site
    const prevRes = await pool.query(`SELECT id FROM scans WHERE site_id = $1 AND status = 'completed' AND id <> $2
     ORDER BY created_at DESC LIMIT 1`, [siteId, scanId]);
    const prevId = prevRes.rows.length > 0 ? prevRes.rows[0].id : null;
    // Load findings for current and previous
    const curFindings = (await pool.query(`SELECT url, rule_id, sc, impact, selectors, excerpt, contrast_ratio, advice, partial
     FROM findings WHERE scan_id = $1`, [scanId])).rows;
    const prevFindings = prevId ? (await pool.query(`SELECT url, rule_id, sc, impact, selectors, excerpt, contrast_ratio, advice, partial
     FROM findings WHERE scan_id = $1`, [prevId])).rows : [];
    const curMap = new Map();
    const prevMap = new Map();
    for (const f of curFindings)
        curMap.set(keyOf(f), f);
    for (const f of prevFindings)
        prevMap.set(keyOf(f), f);
    const newIssues = [];
    const resolvedIssues = [];
    const regressions = [];
    const principleCounts = { Perceivable: { new: 0, resolved: 0, regressions: 0 }, Operable: { new: 0, resolved: 0, regressions: 0 }, Understandable: { new: 0, resolved: 0, regressions: 0 }, Robust: { new: 0, resolved: 0, regressions: 0 } };
    const majorImpacts = new Set(['serious', 'critical']);
    let newMajors = 0;
    // New & regressions
    for (const [key, cf] of curMap) {
        const pf = prevMap.get(key);
        const principle = ruleToPrinciple(cf.rule_id);
        if (!pf) {
            newIssues.push({ ruleId: cf.rule_id, sc: cf.sc, impact: cf.impact, principle });
            principleCounts[principle].new++;
            if (majorImpacts.has((cf.impact || '').toLowerCase()))
                newMajors++;
        }
        else {
            const wPrev = impactWeight(pf.impact);
            const wCur = impactWeight(cf.impact);
            if (wCur > wPrev) {
                regressions.push({ ruleId: cf.rule_id, sc: cf.sc, from: pf.impact, to: cf.impact, principle });
                principleCounts[principle].regressions++;
            }
        }
    }
    // Resolved
    for (const [key, pf] of prevMap) {
        if (!curMap.has(key)) {
            const principle = ruleToPrinciple(pf.rule_id);
            resolvedIssues.push({ ruleId: pf.rule_id, sc: pf.sc, impact: pf.impact, principle });
            principleCounts[principle].resolved++;
        }
    }
    const diff = {
        siteId,
        scanId,
        previousScanId: prevId,
        summary: {
            new: newIssues.length,
            resolved: resolvedIssues.length,
            regressions: regressions.length,
            newMajors,
            byPrinciple: principleCounts,
        },
        newIssues,
        resolvedIssues,
        regressions,
    };
    await pool.query(`INSERT INTO scan_diffs (site_id, scan_id, diff)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`, [siteId, scanId, diff]);
    return diff;
}
export async function getOrComputeDiffForScan(pool, scanId) {
    const r = await pool.query('SELECT diff FROM scan_diffs WHERE scan_id = $1 LIMIT 1', [scanId]);
    if (r.rows.length > 0)
        return r.rows[0].diff;
    return computeAndPersistDiffForScan(pool, scanId);
}
//# sourceMappingURL=history.js.map