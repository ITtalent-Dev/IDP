# Service d'authentification

Fournisseur d'identité central (OAuth 2.1 / OpenID Connect) pour le **Data hub** et l'**App**. Il gère les utilisateurs, les organisations, les rôles et les accès ; les applications se contentent de vérifier les JWT qu'il émet.

- **Technique** : Nuxt 4 (API Nitro + pages Vue), Better Auth 1.7, PostgreSQL + Drizzle, shadcn-vue, Vitest.
- **Clients** : connexion (mot de passe, lien par email, passkey, Google, Microsoft), invitations, gestion de l'organisation, espace « Mon compte ».
- **Équipe** : connexion uniquement via Authentik, administration des organisations et des utilisateurs, impersonation, journal d'audit, archives.

## Organisation du code

```
app/                 Pages, layouts et composants Vue (shadcn-vue dans app/components/ui)
server/api/          Routes Nitro (Better Auth sur api/auth/[...all].ts, admin, account, public)
server/lib/          Cœur indépendant du framework : configuration Better Auth, hooks, claims, Drizzle, emails
server/plugins/      Migrations au démarrage, en-têtes de sécurité, purge quotidienne
shared/permissions.ts  Catalogue des permissions partagé entre le serveur et les pages
scripts/             migrate, seed:clients, seed:demo
tests/               Vitest + Supertest sur le serveur compilé
docs/RGPD.md         Données personnelles, durées de conservation et droits des personnes
```

## Démarrage

> **Méthode recommandée : `pnpm stack:dev`.** L'application tourne dans la stack complète (Vault, Authentik, auth-service, Data hub), avec ses secrets de Vault comme en production, et se recharge à chaque sauvegarde. Voir [Développer dans la stack](#développer-dans-la-stack-recommandé). Les étapes ci-dessous servent à lancer le projet seul, hors de la stack.

Prérequis : Node 22.18+, pnpm 9, Docker.

Authentik, Mailpit et Vault sont lancés par le dossier `stack`, à côté de ce dépôt (`AGO_BACK/stack`) : démarrez-le d'abord avec `docker compose up -d` depuis ce dossier. Le compose de ce dépôt ne lance que le service et sa base :

```bash
docker compose up -d postgres
```

```bash
cp .env.example .env
```

Renseignez `BETTER_AUTH_SECRET` dans `.env` (`openssl rand -base64 32`), puis :

```bash
pnpm install
```

```bash
pnpm migrate
```

```bash
pnpm seed:clients
```

```bash
pnpm dev
```

`docker compose up -d postgres` démarre la base du service (`docker compose up -d` lance aussi le service dans Docker). Le service tourne sur http://localhost:3000 ; Mailpit (http://localhost:8025) et Authentik (http://localhost:9000) viennent du dossier `stack`. `pnpm seed:demo` ajoute des organisations et des comptes de démonstration (en local uniquement ; il affiche leurs identifiants).

### Authentik en local

L'Authentik du dossier `stack` est configuré par un blueprint (`stack/authentik/blueprints/auth-service.yaml`) : un fournisseur OIDC et une application `auth-service`, un groupe `staff` lié à l'application et deux utilisateurs de test. `.env.example` contient déjà les valeurs `AUTHENTIK_*` correspondantes.

| Compte                               | Mot de passe            | Résultat attendu avec « Continuer avec Authentik » sur `/sign-in`          |
| ------------------------------------ | ----------------------- | -------------------------------------------------------------------------- |
| `staff`                              | `staff-password-123`    | Connecté en administrateur global.                                         |
| `outsider`                           | `outsider-password-123` | Refusé par Authentik (« Permission refusée ») : il n'est pas dans `staff`. |
| `akadmin` (administration Authentik) | `authentik-admin-123`   | Administration d'Authentik sur http://localhost:9000/if/admin/.            |

Authentik met environ une minute à démarrer la première fois. Lancez le service d'authentification une fois Authentik prêt : le fournisseur est découvert au démarrage du service, relancez donc `pnpm dev` si Authentik n'était pas encore disponible. Ces identifiants servent uniquement au développement local.

### Scripts

| Script                                       | Description                                                                                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                                   | Serveur de développement Nuxt (API + pages).                                                                                             |
| `pnpm build` / `pnpm start`                  | Build de production dans `.output/`, puis `node .output/server/index.mjs`.                                                               |
| `pnpm migrate`                               | Applique les migrations SQL.                                                                                                             |
| `pnpm auth:generate` puis `pnpm db:generate` | Après une modification de la configuration Better Auth : régénère `server/lib/db/auth-schema.ts`, puis crée une migration.               |
| `pnpm seed:clients`                          | Enregistre ou met à jour les clients OAuth du Data hub et de l'App (idempotent).                                                         |
| `pnpm seed:demo`                             | Données de démonstration pour le développement local.                                                                                    |
| `pnpm test`                                  | Compile, démarre le serveur sur le port 3100 et lance les tests (Postgres et Mailpit requis). `SKIP_BUILD=1` réutilise le dernier build. |
| `pnpm typecheck`                             | Nuxt (app + serveur), puis scripts et tests.                                                                                             |

### Développer dans la stack (recommandé)

Pour tester l'auth-service avec tout l'ensemble (Vault, Authentik, auth-service, Data hub…) sans quitter ce dépôt. Le dossier `stack` doit se trouver à côté de ce dépôt (`AGO_BACK/stack`) ; son README décrit le premier démarrage.

| Besoin                                                            | Commande          |
| ----------------------------------------------------------------- | ----------------- |
| Passer en mode dev (démarre aussi le reste de la stack si besoin) | `pnpm stack:dev`  |
| Suivre les logs (`Ctrl+C` ferme les logs, l'application continue) | `pnpm stack:logs` |
| Quitter le mode dev et revenir à l'image de production            | `pnpm stack:stop` |

Les commandes rendent la main tout de suite : rien ne reste ouvert dans le terminal.

#### Comment ça fonctionne

La stack contient deux versions de l'auth-service :

```text
auth-service      image de production, lancée par `docker compose up -d` dans stack
auth-service-dev  mode dev, démarré uniquement par `pnpm stack:dev`
```

- `stack:dev` arrête `auth-service`, construit `auth-service-dev` (dépendances installées dans l'image) et le démarre avec le code de ce dépôt monté en lecture seule (`app/`, `server/`, `shared/`, `nuxt.config.ts`). À chaque sauvegarde, l'application recompile et redémarre en quelques secondes. Les fichiers sont vérifiés à intervalle régulier : sous Windows, le conteneur n'est pas prévenu des modifications.
- `auth-service-dev` prend le même port (3000) et la même adresse sur le réseau Docker `ago` que `auth-service` : les autres services ne voient aucune différence.
- Ses secrets viennent de Vault, comme en production : le `.env` de ce dépôt n'est pas utilisé. La configuration est dans `stack/auth-service/config.env`.
- `stack:stop` arrête `auth-service-dev` et relance `auth-service` : la stack revient à son état normal.

Les deux versions ne tournent jamais en même temps, puisqu'elles partagent le même port :

- la stack tourne déjà avec l'image de production : `stack:dev` l'arrête lui-même, rien à faire ;
- le mode dev tourne et on veut relancer toute la stack (`docker compose up -d` dans `stack`) : faire d'abord `pnpm stack:stop`, sinon la version de production échoue sur un conflit de port.

Relancer `pnpm stack:dev` après l'ajout d'une dépendance ou une modification de `nuxt.config.ts`. Après une modification de `stack/auth-service/config.env` ou d'un secret dans Vault : `docker compose up -d --force-recreate auth-service-agent auth-service-dev` depuis `stack`.

## Variables d'environnement

Chaque variable est validée avec zod au démarrage ; le serveur refuse de démarrer si la configuration est invalide. La liste complète figure dans [.env.example](.env.example).

| Variable                                                                                      | Rôle                                                                                                                                                  |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_BASE_URL`                                                                               | URL publique, par exemple `https://auth.mondomaine.fr`. L'émetteur des jetons est `${AUTH_BASE_URL}/api/auth`. En `https`, les cookies sont `Secure`. |
| `BETTER_AUTH_SECRET`                                                                          | Secret de signature et de chiffrement (32 caractères minimum).                                                                                        |
| `DATABASE_URL`                                                                                | Chaîne de connexion PostgreSQL.                                                                                                                       |
| `DATAHUB_URL`, `APP_URL`                                                                      | Origines des applications, pour le CORS et les origines de confiance.                                                                                 |
| `DATAHUB_RESOURCE`, `APP_RESOURCE`                                                            | Identifiants de ressource, c'est-à-dire le `aud` des jetons de chaque application.                                                                    |
| `DATAHUB_REDIRECT_URIS`, `APP_REDIRECT_URIS`                                                  | URI de redirection OAuth, séparées par des virgules.                                                                                                  |
| `CLAIMS_NAMESPACE`                                                                            | Préfixe des claims personnalisés (par défaut `https://mondomaine.fr`).                                                                                |
| `ACCESS_TOKEN_TTL_SECONDS`                                                                    | Durée de vie du jeton d'accès (600 par défaut).                                                                                                       |
| `SMTP_*`, `MAIL_FROM`                                                                         | Envoi des emails.                                                                                                                                     |
| `AUTHENTIK_ISSUER`, `AUTHENTIK_CLIENT_ID`, `AUTHENTIK_CLIENT_SECRET`, `AUTHENTIK_REQUIRE_MFA` | Connexion de l'équipe.                                                                                                                                |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                                                    | Connexion Google (facultative).                                                                                                                       |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID`                       | Connexion Microsoft (facultative).                                                                                                                    |
| `RATE_LIMIT_ENABLED`, `TRUSTED_IP_HEADER`                                                     | Limitation des tentatives, et en-tête qui porte la vraie adresse IP derrière votre proxy.                                                             |
| `MIGRATE_ON_START`, `MIGRATIONS_DIR`                                                          | Appliquer les migrations au démarrage du serveur.                                                                                                     |
| `RETENTION_ENABLED`                                                                           | Purge quotidienne des données arrivées au terme de leur durée de conservation (activée par défaut, voir [docs/RGPD.md](docs/RGPD.md)).                |

## Configurer Authentik en production (connexion de l'équipe)

Les comptes de l'équipe sont créés à leur première connexion via Authentik et reçoivent le rôle global `admin`. C'est Authentik qui décide qui peut se connecter.

1. **Fournisseur** : _Applications → Providers → Create → OAuth2/OpenID Provider_.
   - Type de client : **Confidential**.
   - URI de redirection (strict) : `https://auth.mondomaine.fr/api/auth/callback/authentik`.
   - Clé de signature : n'importe quel certificat RSA ou EC (les jetons sont vérifiés avec le JWKS d'Authentik).
   - Scopes : `openid`, `email`, `profile`.
   - Subject mode : basé sur l'identifiant haché de l'utilisateur (valeur par défaut).
2. **Application** : _Applications → Create_, slug `auth-service`, liée au fournisseur. Réglez sa _Launch URL_ sur `https://auth.mondomaine.fr/sign-in?provider=authentik` : la tuile de l'application et le bouton « Se reconnecter » d'Authentik connectent alors l'équipe sans second clic (`?provider=` lance ce fournisseur immédiatement ; un simple `/sign-in` ne le fait jamais).
3. **Réserver à l'équipe** : sur l'application, _Policy / Group / User Bindings → Bind existing group_ → votre groupe d'équipe. Authentik refuse les utilisateurs hors de ce groupe.
4. Reportez les valeurs dans `.env` :
   - `AUTHENTIK_ISSUER=https://authentik.mondomaine.fr/application/o/auth-service` (l'_OpenID Configuration Issuer_ du fournisseur),
   - `AUTHENTIK_CLIENT_ID` et `AUTHENTIK_CLIENT_SECRET`, depuis le fournisseur.

Tout le monde se connecte sur `/sign-in`. La dernière méthode utilisée sur l'appareil (plugin `lastLoginMethod`, cookie de 30 jours) est proposée en premier, en un clic ; il n'y a pas de redirection automatique, qui reconnecterait l'équipe juste après sa déconnexion. L'équipe choisit « Continuer avec Authentik » dans « Options de connexion » et arrive sur `/admin/orgs` ; Authentik refuse toute personne hors du groupe. `/admin/login` redirige vers `/sign-in`.

### Second facteur pour l'équipe

La double authentification de l'équipe est imposée par Authentik et vérifiée par le service :

1. Dans Authentik, ajoutez une étape **Authenticator Validation** au flux d'authentification de l'application `auth-service`, liée au groupe de l'équipe, avec _Not configured action_ réglé sur **Force the user to configure an authenticator** (TOTP et/ou WebAuthn).
2. Gardez `AUTHENTIK_REQUIRE_MFA=true` (valeur par défaut). Le service refuse alors toute connexion de l'équipe dont l'`id_token` Authentik ne contient aucune méthode forte dans `amr` (`mfa`, `otp`, `hwk`, `swk`, `webauthn`…), avec le message « Connexion refusée… ». Sans double authentification, Authentik envoie `amr: ["pwd"]`.

L'Authentik local n'a pas d'étape de double authentification, c'est pourquoi `.env.example` contient `AUTHENTIK_REQUIRE_MFA=false`.

## Double authentification des clients

- **Par organisation** : le gérant (Paramètres → Sécurité) ou un administrateur (détail de l'organisation) peut exiger un second facteur. Les changements sont tracés (`organization.security.update`).
- **Méthodes** : une passkey (recommandé), ou une application d'authentification (TOTP) avec 10 codes de secours à usage unique ; « faire confiance à cet appareil » évite le code TOTP pendant 30 jours. L'une ou l'autre satisfait l'exigence.
- **Passkeys** : ajoutées depuis « Mon compte », puis utilisées avec « Continuer avec une passkey » ou directement depuis le champ email (saisie automatique du navigateur). Elles ne connectent que des comptes existants : l'inscription reste sur invitation. Le domaine de rattachement est celui d'`AUTH_BASE_URL` : une passkey créée sur un domaine ne fonctionne pas sur un autre.
- **Application** : un membre d'une organisation qui l'exige doit l'activer avant toute autre action (`/security/two-factor`), et aucun jeton d'application n'est émis d'ici là. Les liens par email sont refusés aux comptes qui ont ou doivent avoir un second facteur, car ils ne prouvent que l'accès à la boîte mail. La connexion Google est acceptée telle quelle.
- **Impersonation** : elle contourne le second facteur ; l'administrateur agit sans le code de l'utilisateur, et l'action est tracée.
- **Récupération** : pas de code par email (c'est le canal de réinitialisation du mot de passe, les deux facteurs se réduiraient à la boîte mail). Les utilisateurs utilisent leurs codes de secours ou une passkey sur un autre appareil ; en dernier recours, un administrateur réinitialise leurs seconds facteurs depuis la fiche utilisateur (« Réinitialiser la double authentification ») : l'application d'authentification et toutes les passkeys sont supprimées, toutes les sessions sont fermées, et `user.two_factor.reset` est tracé. Les facteurs de l'équipe se gèrent dans Authentik.

## Microsoft (facultatif)

Créez une **App registration** dans le portail Azure (Microsoft Entra ID → App registrations → New registration) :

1. _Supported account types_ : **Accounts in any organizational directory** (multi-tenant, comptes professionnels uniquement).
2. _Redirect URI_ (Web) : `https://auth.mondomaine.fr/api/auth/callback/microsoft`.
3. _Certificates & secrets_ → nouveau secret client.
4. Facultatif mais recommandé : _Token configuration_ → ajoutez le claim optionnel `verified_primary_email` à l'ID token, pour que les personnes invitées puissent s'inscrire directement avec Microsoft.

Renseignez `MICROSOFT_CLIENT_ID` et `MICROSOFT_CLIENT_SECRET` (`MICROSOFT_TENANT_ID` vaut `organizations` par défaut). Entra permet aux administrateurs de chaque entreprise de donner n'importe quel email à leurs utilisateurs : Microsoft n'est donc pas un fournisseur de confiance. Un compte existant se lie depuis « Mon compte → Profil » (même email), et un nouveau compte n'est créé via Microsoft que si Microsoft a vérifié l'email ; sinon, la personne accepte d'abord l'invitation, puis lie Microsoft.

## Google (facultatif)

Créez un client OAuth dans Google Cloud avec l'URI de redirection `https://auth.mondomaine.fr/api/auth/callback/google` et renseignez `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. Un compte Google est lié automatiquement à un compte existant ayant le même email ; un nouvel utilisateur Google a quand même besoin d'une invitation en attente.

## Enregistrer les applications clientes

```bash
pnpm seed:clients
```

Le script crée (ou met à jour) un client confidentiel par application, de confiance (sans écran de consentement), autorisé à demander **uniquement sa propre ressource**, avec les grants `authorization_code` et `refresh_token`. Il affiche chaque `client_id` et, à la création, le `client_secret`. Les secrets sont stockés hachés ; `pnpm seed:clients --rotate-secrets` en émet de nouveaux.

Réglages à utiliser dans les applications :

| Réglage              | Valeur                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| Découverte           | `https://auth.mondomaine.fr/api/auth/.well-known/openid-configuration`                                    |
| Autorisation         | `https://auth.mondomaine.fr/api/auth/oauth2/authorize`                                                    |
| Jeton                | `https://auth.mondomaine.fr/api/auth/oauth2/token` (authentification du client en HTTP Basic)             |
| JWKS                 | `https://auth.mondomaine.fr/api/auth/jwks`                                                                |
| PKCE                 | Obligatoire (`S256`)                                                                                      |
| Scopes               | `openid profile email offline_access`                                                                     |
| Paramètre `resource` | Obligatoire, sur la demande d'autorisation comme sur la demande de jeton : la ressource de l'application. |

## Contenu des jetons d'accès

Les jetons d'accès sont des JWT signés en ES256.

| Claim                                   | Valeur                                                                                                                                                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `iss`                                   | `https://auth.mondomaine.fr/api/auth`                                                                                                                                                                                                                                                       |
| `aud`                                   | La ressource demandée (`DATAHUB_RESOURCE` ou `APP_RESOURCE`). Avec le scope `openid`, `aud` est un tableau qui contient aussi l'endpoint userinfo. **Vérifiez que `aud` contient votre ressource.** Un jeton du Data hub ne contient jamais la ressource de l'App, et inversement.          |
| `sub`                                   | Identifiant de l'utilisateur.                                                                                                                                                                                                                                                               |
| `name` / `email`                        | Nom et email de l'utilisateur, pour personnaliser les écrans.                                                                                                                                                                                                                               |
| `azp`                                   | Identifiant du client.                                                                                                                                                                                                                                                                      |
| `scope`                                 | Scopes accordés.                                                                                                                                                                                                                                                                            |
| `exp` / `iat`                           | Durée de vie de 10 minutes par défaut.                                                                                                                                                                                                                                                      |
| `https://mondomaine.fr/org_id`          | L'**unique** organisation pour laquelle ce jeton agit, choisie par l'utilisateur pendant l'autorisation.                                                                                                                                                                                    |
| `https://mondomaine.fr/org_name`        | Nom de cette organisation. Un changement de nom apparaît au prochain renouvellement du jeton.                                                                                                                                                                                               |
| `https://mondomaine.fr/org_count`       | Nombre d'organisations de l'utilisateur qui donnent accès à **cette** application. Au-dessus de 1, l'application peut proposer de changer d'organisation.                                                                                                                                   |
| `https://mondomaine.fr/access`          | Objet `{ "<orgId>": ["access", "import", ...] }` avec une seule entrée, l'organisation `org_id` : les permissions de l'utilisateur sur **cette** application dans cette organisation, après intersection des permissions de ses rôles avec les applications autorisées pour l'organisation. |
| `https://mondomaine.fr/impersonated_by` | Identifiant de l'administrateur. Présent uniquement pendant une impersonation.                                                                                                                                                                                                              |

Exemple de contenu pour le Data hub :

```json
{
  "iss": "https://auth.mondomaine.fr/api/auth",
  "aud": ["https://datahub.mondomaine.fr", "https://auth.mondomaine.fr/api/auth/oauth2/userinfo"],
  "sub": "u_123",
  "name": "Olivia Owner",
  "email": "owner@acme.fr",
  "azp": "DwLnMccQeKrJRKEkOaFwWrHzxmxsdYTv",
  "scope": "openid profile email offline_access",
  "iat": 1790600000,
  "exp": 1790600600,
  "https://mondomaine.fr/org_id": "org_acme",
  "https://mondomaine.fr/org_name": "Acme",
  "https://mondomaine.fr/org_count": 1,
  "https://mondomaine.fr/access": {
    "org_acme": ["access", "import", "import-read"]
  }
}
```

Garanties :

- **Une organisation par jeton** : un utilisateur membre de plusieurs organisations en choisit une à chaque autorisation (`/select-organization`, qui ne liste que les organisations donnant accès à l'application demandée et se passe d'elle-même s'il n'y en a qu'une). Les jetons de renouvellement gardent cette organisation. Les données de deux clients ne peuvent donc jamais se mélanger dans une même session d'application ; pour changer d'organisation, l'application relance l'autorisation.
- **Forcer le choix de l'organisation** : une application ajoute `prompt=select_account` à la demande d'autorisation (bouton « Changer d'organisation »). La page de choix s'affiche alors toujours, même si l'utilisateur n'a qu'une seule organisation.
- **Pas d'accès, pas de jeton** : si aucune organisation ne donne `access` à l'application demandée, l'endpoint de jeton répond `403 access_denied` et n'émet rien. C'est vrai aussi au renouvellement : retirer un membre, changer un rôle, réduire les applications autorisées d'une organisation ou suspendre un utilisateur prend effet en une durée de vie de jeton d'accès.
- **Jetons machine à machine** (sans utilisateur) : aucun claim personnalisé, sauf pour les connecteurs (voir [Connecteurs](#connecteurs)).
- **Sessions d'impersonation** : jamais de jeton de renouvellement.
- Catalogue des permissions par application : `datahub: access, import, import-read` et `app: access, admin` ([shared/permissions.ts](shared/permissions.ts)). `access` ouvre ou refuse chaque application séparément : un rôle peut avoir accès à l'App sans avoir accès au Data hub. Une organisation n'apparaît dans le jeton d'une application que si l'utilisateur y a `access`, donc les autres actions de cette application en dépendent. L'éditeur de rôles coche `access` dès qu'une autre action de la même application est cochée et décoche les autres actions quand `access` est décoché ; le serveur ajoute `access` à l'enregistrement d'un rôle personnalisé. Les actions hors catalogue (par exemple un ancien `export`) sont ignorées dans les jetons et retirées à l'enregistrement.

## Connecteurs

Un connecteur est une machine installée chez un client (sans personne au clavier) qui envoie chaque jour un import au Data hub. Il s'authentifie **en son nom propre**, est rattaché à **une seule organisation**, ne peut **qu'importer**, et peut être révoqué à tout moment. Aucun secret n'est affiché, copié ni stocké côté serveur : la machine génère sa propre paire de clés et seule la clé publique quitte la machine.

### Fonctionnement

1. **Appairage par code** (sur le modèle du « device flow », RFC 8628) : la machine génère une paire de clés EC P-256, envoie la clé publique et reçoit un code à 8 lettres (`BDFG-HJKL`) valable 10 minutes, à montrer à l'installateur.
2. **Validation par une personne** sur `/connectors/pair` : elle se connecte, saisit le code, choisit l'organisation et le nom du connecteur, puis autorise ou refuse. Seules les organisations où elle a la permission `connector:create` et qui ont accès au Data hub sont proposées.
3. **Récupération de l'identifiant** : la machine interroge le service toutes les 5 secondes ; une fois l'appairage validé, elle reçoit **une seule fois** son `clientId`. Côté serveur, un client OAuth est créé avec `grant_types: ["client_credentials"]`, `token_endpoint_auth_method: "private_key_jwt"`, la clé publique de la machine comme `jwks`, et le Data hub comme unique ressource.
4. **Jetons** : avant chaque import, la machine signe une assertion avec sa clé privée (`private_key_jwt`, RFC 7523) et obtient un jeton d'accès par `client_credentials`. Une assertion ne sert qu'une fois (`jti`), expire en 5 minutes au plus et doit viser l'endpoint de jeton.
5. **Révocation** : depuis « Organisation → Connecteurs ». Le client OAuth est supprimé : plus aucun jeton n'est émis, et le jeton en cours expire au bout de sa durée de vie (10 minutes par défaut).

### Permissions

- Ressource d'organisation `connector` : `create` (« Créer / appairer »), `update` (« Renommer »), `delete` (« Révoquer »). Le gérant les a par défaut ; il peut les donner à d'autres membres avec un rôle personnalisé (page Rôles).
- Permission d'application `datahub:import` : c'est la seule que porte un jeton de connecteur. Le gérant l'a aussi, pour pouvoir importer à la main ; elle suit le plafond `apps` de l'organisation comme les autres permissions d'application. `datahub:import-read` (consulter l'historique et l'état des imports) est une permission distincte, jamais portée par un connecteur.
- Aucun jeton n'est émis si le connecteur est révoqué, si l'organisation a été supprimée ou si elle n'a plus accès au Data hub (`403 access_denied`). Un connecteur ne peut jamais demander de jeton pour une autre ressource (`400 invalid_target`) ni d'autres scopes (`400 invalid_scope`).

### Contenu du jeton d'un connecteur

```json
{
  "iss": "https://auth.mondomaine.fr/api/auth",
  "aud": "https://datahub.mondomaine.fr",
  "sub": "connector-5b0e…",
  "client_id": "connector-5b0e…",
  "azp": "connector-5b0e…",
  "scope": "import",
  "iat": 1790600000,
  "exp": 1790600600,
  "jti": "…",
  "https://mondomaine.fr/org_id": "org_acme",
  "https://mondomaine.fr/org_name": "Acme",
  "https://mondomaine.fr/connector_id": "3f1c…",
  "https://mondomaine.fr/access": { "org_acme": ["import"] }
}
```

Pas de `name`, `email` ni `org_count` : `sub` est l'identifiant du client OAuth du connecteur. Le Data hub exige `import` sur `POST /import-batches` et peut tracer l'import avec `connector_id`.

### Contrat HTTP pour la machine

**1. Demander un appairage** (public, 10 requêtes par minute et par IP) :

```http
POST /api/connectors/pairing
Content-Type: application/json

{ "publicKey": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" }, "name": "Serveur agence Lyon" }
```

```json
{
  "deviceCode": "k3J…",
  "userCode": "BDFG-HJKL",
  "verificationUri": "https://auth.mondomaine.fr/connectors/pair",
  "verificationUriComplete": "https://auth.mondomaine.fr/connectors/pair?code=BDFG-HJKL",
  "expiresIn": 600,
  "interval": 5
}
```

Une clé privée (membre `d`) ou une clé qui n'est pas une clé EC P-256 valide est refusée (`400`). Le `deviceCode` reste dans la machine : le serveur n'en garde qu'une empreinte.

**2. Attendre la validation** (public, 30 requêtes par minute et par IP), toutes les `interval` secondes :

```http
POST /api/connectors/pairing/token
Content-Type: application/json

{ "deviceCode": "k3J…" }
```

- `400 { "error": "authorization_pending" }` : pas encore validé, réessayer ;
- `400 { "error": "slow_down" }` : trop rapide, ajouter 5 secondes à l'intervalle ;
- `400 { "error": "expired_token" }` : code expiré, recommencer l'étape 1 ;
- `400 { "error": "access_denied" }` : appairage refusé ;
- `400 { "error": "invalid_grant" }` : code inconnu ou déjà utilisé ;
- `200`, une seule fois :

```json
{
  "clientId": "connector-5b0e…",
  "issuer": "https://auth.mondomaine.fr/api/auth",
  "tokenEndpoint": "https://auth.mondomaine.fr/api/auth/oauth2/token",
  "resource": "https://datahub.mondomaine.fr"
}
```

**3. Obtenir un jeton d'accès** avant chaque import. L'assertion est un JWT signé en ES256 avec la clé privée de la machine, de contenu :

```json
{
  "iss": "<clientId>",
  "sub": "<clientId>",
  "aud": "<tokenEndpoint>",
  "jti": "<uuid aléatoire>",
  "iat": 1790600000,
  "exp": 1790600120
}
```

```http
POST /api/auth/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_assertion_type=urn%3Aietf%3Aparams%3Aoauth%3Aclient-assertion-type%3Ajwt-bearer
&client_assertion=eyJhbGciOiJFUzI1NiJ9…
&resource=https%3A%2F%2Fdatahub.mondomaine.fr
```

Exemple avec `jose` (Node.js) :

```ts
const assertion = await new SignJWT({})
  .setProtectedHeader({ alg: "ES256" })
  .setIssuer(clientId)
  .setSubject(clientId)
  .setAudience(tokenEndpoint)
  .setJti(crypto.randomUUID())
  .setIssuedAt()
  .setExpirationTime("2m")
  .sign(privateKey);
```

Réponse : `{ "access_token": "eyJ…", "token_type": "Bearer", "expires_in": 600, "scope": "import" }`. Pas de jeton de renouvellement : la machine signe une nouvelle assertion à chaque fois.

**4. Appeler le Data hub** avec le jeton :

```http
POST https://datahub.mondomaine.fr/import-batches
Authorization: Bearer eyJ…
```

### Gestion

- `/org/connectors` (« Organisation → Connecteurs ») : liste des connecteurs de l'organisation active (nom, auteur de l'appairage, dates, dernière connexion, statut), renommage et révocation selon les permissions.
- L'équipe voit et révoque les connecteurs de toute organisation depuis `/admin/orgs` (onglet Connecteurs).
- API de gestion (organisation active) : `GET /api/account/organization/connectors` (une des permissions `connector`), `PATCH /api/account/organization/connectors/:id` (`{ "name": "…" }`, `connector:update`), `DELETE /api/account/organization/connectors/:id` (`connector:delete`).
- API de validation (`connector:create` sur l'organisation choisie) : `GET /api/account/connectors/organizations`, `GET /api/account/connectors/pairing?code=`, `POST /api/account/connectors/pairing/approve` (`{ userCode, organizationId, name }`) et `POST /api/account/connectors/pairing/deny` (`{ userCode, organizationId }`).
- Journal d'audit : `connector.paired`, `connector.pairing.denied`, `connector.renamed`, `connector.revoked`, avec l'auteur, l'organisation et le nom du connecteur.

## Modèle d'accès

- **Organisations** : créées par l'équipe (`/admin/orgs`) avec un nom, un slug, les applications autorisées (plafond `apps`) et l'email du futur gérant, qui reçoit une invitation. L'équipe peut ensuite inviter une personne avec n'importe quel rôle de l'organisation. Les membres de l'équipe ne deviennent jamais membres.
- **Rôles** : `owner` (gérant : membres, invitations, rôles, connecteurs, paramètres ; toutes les permissions d'application) et `member` (aucune permission d'application). Les gérants créent d'autres rôles depuis leur espace ; ils ne peuvent choisir que des permissions sur les applications autorisées pour leur organisation, et le serveur refuse tout ce qui dépasse ce plafond.
- **Gérants** : ils modifient le nom et le logo de l'organisation (Paramètres) et peuvent transférer leur rôle à un autre membre. L'organisation garde toujours au moins un gérant.
- **Membres** : ils peuvent quitter une organisation depuis « Mon compte → Profil ».
- **Inscription sur invitation uniquement**, quelle que soit la méthode (mot de passe, lien par email, Google, Microsoft), sauf pour l'équipe venant d'Authentik.
- **Journal d'audit** (`/admin/audit`) : impersonation, création, modification et suppression d'organisations, plafonds, rôles, invitations, changements de rôle, retraits et départs de membres, transferts du rôle de gérant, suspensions, suppressions et exports de comptes, l'appairage, le refus, le renommage et la révocation des connecteurs, ainsi que l'activation ou la désactivation de la double authentification et l'ajout ou la suppression de passkeys par l'utilisateur lui-même.

## Déploiement

```bash
docker build -t auth-service .
```

L'image lance `node .output/server/index.mjs` avec un utilisateur non root sur le port 3000 et embarque les migrations dans `/app/migrations` (`MIGRATE_ON_START=true` les applique au démarrage). Placez-la derrière un reverse proxy qui termine le TLS et renseigne l'en-tête indiqué dans `TRUSTED_IP_HEADER`. Lancez `pnpm seed:clients` depuis une copie du dépôt pointée sur la base de production pour enregistrer les applications.

## Versions et image Docker

Les versions sont calculées par [semantic-release](https://semantic-release.gitbook.io) à partir du [gitmoji](https://gitmoji.dev) de chaque commit poussé sur `main` ou `dev` (`.github/workflows/release.yml`, `.releaserc.json`) :

| Gitmoji                          | Version        |
| -------------------------------- | -------------- |
| 💥                               | majeure        |
| ✨                               | mineure        |
| 🐛 🚑️ 🔒️ ⚡️ ♻️ 🏷️ 🩹 🥅 ⬆️ ⬇️ 📌 | correctif      |
| tout le reste (📝, ✅, 🔧, 🎨…)  | pas de version |

| Branche | Version publiée                          | Tags de l'image Docker          |
| ------- | ---------------------------------------- | ------------------------------- |
| `dev`   | préversion `x.y.z-dev.n` (`1.0.0-dev.1`) | `x.y.z-dev.n` et `dev`          |
| `main`  | version `x.y.z` (`1.0.0`)                | `x.y.z`, `x.y`, `x` et `latest` |

Chaque version crée un tag git `vX.Y.Z` et une release GitHub avec ses notes (les préversions sont marquées comme telles). Le champ `version` du `package.json` est un simple marqueur : aucun commit de version n'est poussé. Le workflow exécute d'abord les contrôles (lint, format, typecheck, tests sur PostgreSQL 17, build), puis la release, puis la construction de l'image du `Dockerfile` si une version a été publiée.

Les images sont publiées sur GitHub Container Registry :

```bash
docker pull ghcr.io/ittalent-dev/auth-service:1.0.0
docker pull ghcr.io/ittalent-dev/auth-service:dev
```

Pour passer une préversion en version stable, fusionnez `dev` dans `main` (`git switch main && git merge dev && git push`) : la version stable correspondante (`1.0.0` après `1.0.0-dev.3`) est calculée à partir des commits fusionnés. Ne poussez pas de correctif directement sur `main` sans le reporter dans `dev`.

## Sécurité

- **Mots de passe ayant fuité** : refusés à l'inscription, au changement et à la réinitialisation (plugin Better Auth `haveIBeenPwned` : seuls les 5 premiers caractères de l'empreinte SHA-1 du mot de passe sont envoyés au service). Si le service est injoignable, le mot de passe est refusé plutôt qu'accepté sans vérification.
- **Documentation de l'API** sur `/api/auth/reference` (OpenAPI de Better Auth, interface Scalar) et schéma brut sur `/api/auth/open-api/generate-schema`, réservés aux administrateurs (404 pour tous les autres). Elle couvre les endpoints Better Auth ; les applications s'intègrent via la découverte OIDC.
- **Alertes de sécurité** par email : connexion depuis un nouveau navigateur (reconnu par un cookie aléatoire `auth_device`, stocké haché dans `known_device` ; le premier navigateur d'un compte et les sessions d'impersonation ne déclenchent pas d'alerte), mot de passe modifié ou réinitialisé, double authentification activée ou désactivée, passkey ajoutée ou supprimée, seconds facteurs réinitialisés par le support, export des données.
- **RGPD** : les données personnelles, les durées de conservation, la suppression et les droits des personnes sont décrits dans [docs/RGPD.md](docs/RGPD.md).
- **Suppression de compte** : depuis la page Profil, confirmée par un lien envoyé par email et valable 1 heure (`POST /api/account/deletion`, puis `/api/account/deletion/confirm`), ou par un administrateur à la demande de la personne (`DELETE /api/admin/users/:id`). Le compte est **pseudonymisé** : l'identifiant reste pour les applications, tout le reste est effacé. Une archive (identité et historique de connexion) est gardée 1 an pour les réquisitions des autorités, consultable depuis `/admin/archives`. La suppression est refusée au seul gérant d'une organisation et aux comptes de l'équipe. Les routes de suppression de Better Auth (`/delete-user`, `/admin/remove-user`) sont désactivées.
- **Export des données** (droit d'accès), réservé aux administrateurs pour l'instant : `GET /api/admin/users/:id/export` renvoie un fichier JSON (profil, moyens de connexion, passkeys, appareils connus, sessions, organisations, invitations, applications autorisées, activité). Les secrets (empreinte du mot de passe, secrets de 2FA, clés de passkey, jetons) ne sont jamais inclus ; chaque export est tracé et la personne est prévenue par email.
- **Durées de conservation** appliquées chaque jour par une tâche qui ne tourne que sur un serveur à la fois : journal d'audit 1 an, appareils connus 13 mois sans activité, archives 1 an, invitations, liens et appairages de connecteurs expirés, comptes inactifs supprimés après 3 ans (avec un avertissement 30 jours avant).
- **Suppression d'organisation** : réservée aux administrateurs, avec saisie du slug pour confirmer ; elle supprime les membres, les invitations, les rôles, les connecteurs (et leurs clients OAuth), ainsi que les consentements et jetons de renouvellement liés à l'organisation.
- **Logos des organisations** : images PNG, JPEG ou WebP (réduites à 256 px dans le navigateur, 200 Ko maximum, jamais de SVG), servies par `/api/public/organizations/:id/logo?v=<empreinte>` avec un cache permanent.
- Les cookies sont `httpOnly`, `sameSite=lax` et `Secure` en HTTPS.
- Le CORS et les origines de confiance sont limités aux origines des applications.
- CSP stricte (`script-src 'self'` plus les empreintes des scripts de démarrage de Nuxt), `frame-ancestors 'none'`, HSTS en HTTPS.
- La limitation des tentatives de Better Auth est stockée en base, avec des limites plus strictes sur la connexion, l'inscription, les liens par email, la réinitialisation du mot de passe et les invitations. Les routes d'appairage des connecteurs ont leurs propres limites, dans la même table.
- Chaque route d'administration vérifie le rôle global `admin` côté serveur ; les opérations sur les organisations passent par les contrôles de permissions de Better Auth.
- Les logs sont en JSON et masquent toute clé ressemblant à un secret (jetons, mots de passe, cookies).

## Dépannage

| Message                                                                                               | Cause                                                                                                                                                                                                                                                                                             | Solution                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page « invalid_client — client_id is required » sur `/api/auth/oauth2/authorize`                      | Le client OAuth de l'application n'existe pas dans la base, en général après une réinitialisation de la base.                                                                                                                                                                                     | `pnpm seed:clients`, puis reporter le nouveau `client_id` et le `client_secret` dans le `.env` de l'application et la redémarrer.                                         |
| « Connexion refusée. Pour l'équipe, la double authentification doit être configurée dans Authentik. » | Authentik a renvoyé `amr: ["pwd"]` (le log `authentik sign-in refused: no second factor` l'affiche) : la session Authentik a été ouverte sans second facteur, ou sur une autre adresse que celle d'`AUTHENTIK_ISSUER` (`localhost:9000` et `authentik.localhost:9000` ont des sessions séparées). | Se déconnecter d'Authentik sur l'adresse d'`AUTHENTIK_ISSUER` (`/flows/-/default/invalidation/`), vérifier qu'un appareil TOTP ou WebAuthn est configuré, puis réessayer. |
| « Continuer avec Authentik » échoue juste après le démarrage                                          | Authentik n'était pas prêt quand le service a démarré : le fournisseur est découvert au démarrage.                                                                                                                                                                                                | Attendre qu'Authentik soit prêt, puis redémarrer le service.                                                                                                              |
| Les comptes de démonstration n'existent pas                                                           | La base est neuve ou a été réinitialisée.                                                                                                                                                                                                                                                         | `pnpm seed:demo`.                                                                                                                                                         |
| `pnpm seed:clients` affiche `(unchanged — run pnpm seed:clients --rotate-secrets …)`                  | Le client existe déjà : son secret n'est affiché qu'à la création.                                                                                                                                                                                                                                | `pnpm seed:clients --rotate-secrets`, puis mettre à jour les applications.                                                                                                |
| Tout le monde est déconnecté, plus aucun client OAuth ni compte                                       | Le volume Postgres a été supprimé (`docker compose down -v`) : comptes, clients OAuth, connecteurs et clé de signature sont perdus, une nouvelle clé est créée au démarrage.                                                                                                                      | Ne pas utiliser `down -v` sauf pour tout réinitialiser. Sinon : `pnpm seed:clients` (et `pnpm seed:demo` en local), puis mettre à jour les applications.                  |
| Le job de release échoue avec `GH006` ou `403` au push du tag                                         | Les permissions du workflow sont en lecture seule.                                                                                                                                                                                                                                                | Réglages → Actions → General → Workflow permissions : « Read and write permissions ».                                                                                     |
| Une release a échoué en laissant un tag `vX.Y.Z` sans release, et l'exécution suivante ne publie rien | semantic-release pousse le tag avant de publier ; les commits suivants ne déclenchent pas de version à eux seuls.                                                                                                                                                                                 | Supprimer le tag orphelin en local et sur le dépôt distant (`git push origin :refs/tags/vX.Y.Z`), puis relancer le workflow.                                              |
| Un push sur `main` ou `dev` ne publie aucune nouvelle version                                         | Le gitmoji du commit ne déclenche pas de version (par exemple 📝, ✅, 🔧, 👷, 💚).                                                                                                                                                                                                                | C'est normal : seuls 💥, ✨ et les gitmojis de correctif listés dans « Versions et image Docker » créent une version.                                                     |
| Le job `image` est ignoré                                                                             | Aucune version n'a été publiée par le job `release`.                                                                                                                                                                                                                                              | Voir la ligne précédente.                                                                                                                                                 |
| `docker pull` répond `denied` ou `not found`                                                          | Le paquet GHCR est privé ou n'est pas encore rattaché au dépôt.                                                                                                                                                                                                                                   | Se connecter avec `docker login ghcr.io` (jeton `read:packages`) ou rendre le paquet public dans ses réglages.                                                            |
