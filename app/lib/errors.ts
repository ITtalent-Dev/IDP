const MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "Email ou mot de passe incorrect.",
  PASSWORD_COMPROMISED:
    "Ce mot de passe apparaît dans des fuites de données connues : il serait facile à deviner. Choisissez-en un autre.",
  TWO_FACTOR_PASSWORD_REQUIRED:
    "Votre compte est protégé par la double authentification : connectez-vous avec votre passkey ou votre mot de passe.",
  PASSKEY_NOT_FOUND: "Cette passkey n'est liée à aucun compte.",
  STAFF_MANAGED_BY_AUTHENTIK: "La double authentification de l'équipe se gère dans Authentik.",
  PASSKEY_USER_VERIFICATION_REQUIRED:
    "Cette passkey doit être déverrouillée par un code PIN, votre empreinte ou votre visage.",
  AUTHENTICATION_FAILED: "La vérification de la passkey a échoué.",
  FAILED_TO_VERIFY_REGISTRATION: "La passkey n'a pas pu être enregistrée.",
  AUTH_CANCELLED: "Opération annulée.",
  ERROR_CEREMONY_ABORTED: "Opération annulée.",
  INVALID_CODE: "Code incorrect.",
  INVALID_BACKUP_CODE: "Code de secours incorrect.",
  OTP_HAS_EXPIRED: "Le code a expiré.",
  TWO_FACTOR_NOT_ENABLED: "La double authentification n'est pas activée.",
  INVALID_TWO_FACTOR_COOKIE: "La vérification a expiré, reconnectez-vous.",
  ACCOUNT_TEMPORARILY_LOCKED: "Trop de tentatives échouées. Réessayez dans quelques minutes.",
  TOTP_ALREADY_ENABLED: "La double authentification est déjà activée.",
  EMAIL_NOT_VERIFIED: "Votre adresse email n'est pas encore confirmée. Un nouveau lien vient de vous être envoyé.",
  INVALID_EMAIL: "Adresse email invalide.",
  PASSWORD_TOO_SHORT: "Le mot de passe doit contenir au moins 10 caractères.",
  PASSWORD_TOO_LONG: "Le mot de passe est trop long.",
  INVALID_PASSWORD: "Mot de passe incorrect.",
  INVALID_TOKEN: "Ce lien n'est plus valide. Demandez-en un nouveau.",
  TOKEN_EXPIRED: "Ce lien a expiré. Demandez-en un nouveau.",
  USER_ALREADY_EXISTS: "Un compte existe déjà avec cette adresse.",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "Un compte existe déjà avec cette adresse.",
  SIGNUP_REQUIRES_INVITATION: "L'inscription se fait uniquement sur invitation.",
  BANNED_USER: "Votre compte a été suspendu. Contactez le support.",
  SESSION_EXPIRED: "Votre session a expiré, reconnectez-vous.",
  SESSION_NOT_FRESH: "Pour des raisons de sécurité, reconnectez-vous avant cette action.",
  UNAUTHORIZED: "Vous devez être connecté.",
  FORBIDDEN: "Vous n'avez pas les droits nécessaires.",
  NOT_FOUND: "Élément introuvable.",
  VALIDATION_ERROR: "Certains champs sont invalides.",
  SLUG_TAKEN: "Ce slug est déjà utilisé par une autre organisation.",
  ORGANIZATION_NOT_FOUND: "Organisation introuvable.",
  INVITATION_NOT_FOUND: "Cette invitation n'existe pas, a expiré ou a déjà été utilisée.",
  YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION:
    "Cette invitation a été envoyée à une autre adresse. Connectez-vous avec le bon compte.",
  EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION:
    "Confirmez d'abord votre adresse email pour accepter l'invitation.",
  USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION: "Cette personne est déjà membre de l'organisation.",
  USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION: "Une invitation est déjà en attente pour cette adresse.",
  YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION: "Vous ne pouvez pas inviter de membres.",
  YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE: "Vous ne pouvez pas inviter avec ce rôle.",
  YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER: "L'organisation doit garder au moins un gérant.",
  YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER: "L'organisation doit garder au moins un gérant.",
  PERMISSION_OUTSIDE_CEILING: "Ce rôle contient des permissions sur une application non autorisée pour l'organisation.",
  ROLE_NAME_IS_ALREADY_TAKEN: "Un rôle porte déjà ce nom.",
  TOO_MANY_ROLES: "Nombre maximum de rôles atteint.",
  ROLE_IS_ASSIGNED_TO_MEMBERS: "Ce rôle est encore attribué à des membres.",
  CANNOT_DELETE_A_PRE_DEFINED_ROLE: "Les rôles par défaut ne peuvent pas être supprimés.",
  FAILED_TO_UNLINK_LAST_ACCOUNT: "Impossible de délier votre seul moyen de connexion.",
  SOCIAL_ACCOUNT_ALREADY_LINKED: "Ce compte est déjà lié.",
  MICROSOFT_EMAIL_NOT_VERIFIED:
    "Microsoft ne garantit pas cette adresse. Acceptez d'abord votre invitation, puis liez Microsoft depuis Mon compte.",
  YOU_CANNOT_IMPERSONATE_ADMINS: "Impossible de se connecter en tant qu'un autre administrateur.",
  YOU_CANNOT_BAN_YOURSELF: "Vous ne pouvez pas vous suspendre vous-même.",
  TOO_MANY_REQUESTS: "Trop de tentatives. Patientez une minute avant de réessayer.",
  UNKNOWN_ROLE: "Ce rôle n'existe pas dans l'organisation.",
  ALREADY_MEMBER: "Cette personne est déjà membre de l'organisation.",
  MEMBER_NOT_FOUND: "Ce membre n'appartient pas à l'organisation.",
  NOT_AN_OWNER: "Seul un gérant peut transférer ce rôle.",
  ALREADY_OWNER: "Cette personne est déjà gérante.",
  SOLE_OWNER: "Vous êtes le seul gérant d'une organisation : transférez d'abord ce rôle à un autre membre.",
  STAFF_ACCOUNT_MANAGED_IN_AUTHENTIK: "Les comptes de l'équipe se gèrent dans Authentik.",
  CONFIRMATION_MISMATCH: "La confirmation ne correspond pas.",
  YOU_CANNOT_REMOVE_YOURSELF: "Vous ne pouvez pas supprimer votre propre compte ici.",
  USER_NOT_FOUND: "Utilisateur introuvable.",
  INVALID_ORGANIZATION_NAME: "Le nom doit contenir entre 1 et 120 caractères.",
  INVALID_LOGO: "Le logo doit être une image PNG, JPEG ou WebP.",
  LOGO_TOO_LARGE: "Le logo est trop lourd.",
  ORGANIZATION_FIELD_ADMIN_ONLY: "Seule notre équipe peut modifier ce champ.",
  PAIRING_NOT_FOUND: "Ce code est inconnu ou a expiré. Relancez l'appairage depuis l'appareil.",
  APP_NOT_ENABLED: "Cette organisation n'a pas accès à l'application de cet appareil.",
  NAME_REQUIRED: "Donnez un nom à l'appareil.",
  CONNECTOR_NOT_FOUND: "Cet appareil n'existe pas.",
  CONNECTOR_REVOKED: "Cet appareil est déjà révoqué.",
  NO_ACTIVE_ORGANIZATION: "Choisissez d'abord une organisation.",
};

export interface AppError {
  code?: string;
  message?: string;
  status?: number;
  statusCode?: number;
  data?: { code?: string };
}

export function errorMessage(error: unknown): string {
  if (!error) return "";
  const e = error as AppError;
  const status = e.status ?? e.statusCode;
  const code = e.code ?? e.data?.code;

  if (status === 429) return MESSAGES.TOO_MANY_REQUESTS!;
  if (code && MESSAGES[code]) return MESSAGES[code]!;
  const normalized = e.message
    ?.toUpperCase()
    .replace(/[^A-Z]+/g, "_")
    .replace(/^_|_$/g, "");

  if (normalized && MESSAGES[normalized]) return MESSAGES[normalized]!;
  if (status === 401) return MESSAGES.UNAUTHORIZED!;
  if (status === 403) return MESSAGES.FORBIDDEN!;

  return "Une erreur est survenue. Réessayez dans un instant.";
}

const URL_ERRORS: Record<string, string> = {
  INVALID_TOKEN: MESSAGES.INVALID_TOKEN!,
  invalid_token: MESSAGES.INVALID_TOKEN!,
  EXPIRED_TOKEN: MESSAGES.TOKEN_EXPIRED!,
  token_expired: MESSAGES.TOKEN_EXPIRED!,
  signup_disabled: MESSAGES.SIGNUP_REQUIRES_INVITATION!,
  unable_to_create_user:
    "Aucun compte ne correspond. Créez le vôtre avec le lien de votre invitation, puis liez Google ou Microsoft depuis Mon compte.",
  SIGNUP_REQUIRES_INVITATION: MESSAGES.SIGNUP_REQUIRES_INVITATION!,
  access_denied: "Accès refusé : aucune de vos organisations n'a accès à cette application.",
  unable_to_get_user_info:
    "Connexion refusée. Pour l'équipe, la double authentification doit être configurée dans Authentik.",
  account_not_linked:
    "Ce compte n'est pas encore lié. Connectez-vous autrement, puis liez-le depuis Mon compte → Profil.",
  banned: MESSAGES.BANNED_USER!,
};

export function urlErrorMessage(code: unknown) {
  const value = Array.isArray(code) ? code.at(-1) : code;

  return typeof value === "string" && value ? (URL_ERRORS[value] ?? "La connexion a échoué. Réessayez.") : "";
}
