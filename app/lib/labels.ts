export const RESOURCE_LABELS: Record<string, string> = {
  organization: "Organisation",
  member: "Membres",
  invitation: "Invitations",
  ac: "Rôles",
  connector: "Appareils",
  datahub: "Data hub",
  app: "App",
};

const ACTION_LABELS: Record<string, Record<string, string>> = {
  organization: { update: "Modifier les informations" },
  member: { create: "Ajouter", update: "Changer les rôles", delete: "Retirer" },
  invitation: { create: "Inviter", cancel: "Annuler une invitation" },
  ac: { create: "Créer", read: "Consulter", update: "Modifier", delete: "Supprimer" },
  connector: { create: "Créer / appairer", update: "Renommer", delete: "Révoquer" },
  datahub: {
    access: "Accès au Data hub",
    import: "Envoyer des imports",
    "import-read": "Consulter les imports",
  },
  app: { access: "Accès à l'App", admin: "Administration" },
};

export const CONNECTOR_KIND_LABELS: Record<string, { label: string; capability: string }> = {
  import: { label: "Connecteur d'import", capability: "importer des données dans le Data hub" },
  impression: { label: "Poste d'impression", capability: "générer et vérifier des codes-barres dans AGO" },
};

export const connectorKindLabel = (kind: string) => CONNECTOR_KIND_LABELS[kind]?.label ?? kind;

export const actionLabel = (resource: string, action: string) => ACTION_LABELS[resource]?.[action] ?? action;

export const roleLabel = (role: string) =>
  role
    .split(",")
    .map((r) => (r === "owner" ? "Gérant" : r === "member" ? "Membre" : r))
    .join(", ");

export const AUDIT_LABELS: Record<string, string> = {
  "impersonation.start": "Début d'impersonation",
  "impersonation.stop": "Fin d'impersonation",
  "organization.create": "Création d'organisation",
  "organization.update": "Modification d'organisation",
  "organization.ceiling.update": "Modification du plafond",
  "organization.security.update": "Règle de double authentification",
  "organization.delete": "Suppression d'organisation",
  "organization.owner.transfer": "Transfert du rôle de gérant",
  "role.create": "Création de rôle",
  "role.update": "Modification de rôle",
  "role.delete": "Suppression de rôle",
  "invitation.create": "Invitation",
  "member.role.update": "Changement de rôle",
  "member.remove": "Retrait de membre",
  "member.leave": "Départ d'un membre",
  "user.ban": "Suspension",
  "user.unban": "Levée de suspension",
  "user.role.update": "Changement de rôle global",
  "user.two_factor.reset": "Réinitialisation de la 2FA",
  "user.two_factor.enable": "Activation de la 2FA",
  "user.two_factor.disable": "Désactivation de la 2FA",
  "user.passkey.add": "Ajout d'une passkey",
  "user.passkey.remove": "Suppression d'une passkey",
  "user.delete": "Suppression de compte",
  "user.tokens.revoke": "R�vocation des jetons de rafra�chissement",
  "user.export": "Export des données",
  "user.inactivity.kept": "Compte inactif conservé (seul gérant)",
  "archive.export": "Consultation d'une archive",
  "connector.paired": "Appairage d'un appareil",
  "connector.pairing.denied": "Appairage refusé",
  "connector.renamed": "Appareil renommé",
  "connector.revoked": "Appareil révoqué",
};

export const formatDate = (value: string | Date | null | undefined) =>
  value ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";

const ROLE_DESCRIPTIONS: Record<string, string> = {
  owner: "Gestion complète et accès à toutes les applications autorisées",
  member: "Aucune permission d'application",
};

export const roleOptions = (roles: string[]) =>
  [...new Set(roles)].map((role) => ({
    value: role,
    label: roleLabel(role),
    description: ROLE_DESCRIPTIONS[role] ?? "Rôle personnalisé",
  }));
