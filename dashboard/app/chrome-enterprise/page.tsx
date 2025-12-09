export default function ChromeEnterprisePage() {
  return (
    <div>
      <h1>Chrome Enterprise deployment</h1>
      <p>Cette page fournit des informations sur le déploiement de Chrome dans un contexte entreprise pour garantir des scans fiables et reproductibles.</p>
      <h2>Points clés</h2>
      <ul>
        <li>Verrouiller la version de Chrome/Chromium utilisée par le scanner (variable d’environnement CHROME_PATH si nécessaire).</li>
        <li>Assurer les mises à jour de sécurité et la compatibilité avec axe-core.</li>
        <li>Configurer les politiques d’entreprise (GPO/MDM) pour contrôler extensions, certificats, et paramètres réseau.</li>
        <li>Surveiller la version capturée dans les rapports (champ chrome_version).</li>
      </ul>
      <p>
        Ressources utiles: <a href="https://chromeenterprise.google/browser/" target="_blank" rel="noreferrer">Chrome Enterprise</a>.
      </p>
    </div>
  );
}