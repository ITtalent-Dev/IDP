<script setup lang="ts">
import {
  AppWindow,
  ArrowUpRight,
  Building2,
  ChevronRight,
  Database,
  KeyRound,
  MailPlus,
  Plus,
  ScanBarcode,
  ScrollText,
  ShieldAlert,
  UserPlus,
  Users,
} from "lucide-vue-next";
import { authClient, isGlobalAdmin } from "~/lib/auth-client";
import { errorMessage } from "~/lib/errors";
import { actionLabel, AUDIT_LABELS, formatDate, roleLabel } from "~/lib/labels";
import type { Dashboard, OrganizationInsights } from "~/lib/types";

definePageMeta({ middleware: "auth" });
useHead({ title: "Tableau de bord" });

const APP_STYLES: Record<string, { icon: Component; tile: string }> = {
  datahub: { icon: Database, tile: "bg-brand text-brand-foreground" },
  app: { icon: ScanBarcode, tile: "bg-brand text-brand-foreground" },
};
const appStyle = (id: string) => APP_STYLES[id] ?? { icon: AppWindow, tile: "bg-muted text-foreground" };

const session = authClient.useSession();
const data = ref<Dashboard | null>(null);
const error = ref("");

const isAdmin = computed(() => isGlobalAdmin(session.value.data?.user));
const firstName = computed(() => session.value.data?.user.name?.split(" ")[0] ?? "");
const { context, load: loadContext } = useAccountContext();
const insights = ref<OrganizationInsights | null>(null);
const canManage = computed(() => !!context.value?.active?.canManage);
const profile = computed(() => {
  if (isAdmin.value) return "Administrateur";
  const org = data.value?.organization;

  return org ? `${roleLabel(org.role)} · ${org.name}` : "Membre";
});
const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`;

const hero = computed(() => {
  const d = data.value;

  if (!d) return null;
  if (d.admin) {
    const stale = d.admin.stats.staleInvitations;

    return {
      message: stale
        ? `${plural(stale, "invitation")} attend${stale > 1 ? "ent" : ""} une réponse depuis plus de 3 jours.`
        : "Tout est à jour, aucune invitation ne traîne.",
      actions: [
        { label: "Nouvelle organisation", icon: Plus, to: "/admin/orgs", primary: true },
        { label: "Journal", icon: ScrollText, to: "/admin/audit" },
      ],
    };
  }

  const org = d.organization;

  if (org && canManage.value) {
    const pending = org.pendingInvitations ?? 0;

    return {
      message: pending
        ? `${plural(pending, "invitation")} en attente dans ${org.name}.`
        : `${org.name} compte ${plural(org.memberCount, "membre")}.`,
      actions: [
        { label: "Inviter un membre", icon: UserPlus, to: "/org?invite=1", primary: true },
        { label: "Gérer l'organisation", icon: Building2, to: "/org" },
      ],
    };
  }

  const app = d.apps[0];

  return {
    message: app
      ? `Vous avez accès à ${plural(d.apps.length, "application")}.`
      : "Aucune application ne vous est encore ouverte.",
    actions: app ? [{ label: `Ouvrir ${app.label}`, icon: ArrowUpRight, href: app.url, primary: true }] : [],
  };
});

const managerStats = computed(() => {
  const s = insights.value?.stats;

  if (!s) return [];
  const required = context.value?.active?.requireTwoFactor === true;
  const missing = s.members - s.twoFactorEnabled;

  return [
    {
      label: "Membres",
      value: String(s.members),
      hint: s.pendingInvitations
        ? `+${s.pendingInvitations} invitation${s.pendingInvitations > 1 ? "s" : ""} en attente`
        : "Aucune invitation en attente",
      icon: Users,
      tone: "bg-brand-soft text-foreground",
      to: "/org",
    },
    {
      label: "Invitations en attente",
      value: String(s.pendingInvitations),
      hint: s.pendingInvitations ? "Valables 7 jours" : "Tout le monde a répondu",
      icon: MailPlus,
      tone: "bg-brand-soft text-foreground",
      to: "/org?filter=pending",
    },
    {
      label: "Double authentification",
      value: `${s.twoFactorEnabled}/${s.members}`,
      hint: required
        ? missing
          ? `Obligatoire · ${missing} à activer`
          : "Obligatoire · tout le monde est protégé"
        : "Facultative",
      warn: required && missing > 0,
      trend: missing === 0 && s.members > 0,
      icon: ShieldAlert,
      tone: "bg-brand-soft text-foreground",
      to: "/org/settings",
    },
    {
      label: "Rôles personnalisés",
      value: String(s.customRoles),
      hint: s.customRoles ? "En plus de Gérant et Membre" : "Seulement Gérant et Membre",
      icon: KeyRound,
      tone: "bg-brand-soft text-foreground",
      to: "/org/roles",
    },
  ];
});

const activity = computed(() => data.value?.admin?.recentActivity ?? insights.value?.recentActivity ?? null);

const stats = computed(() => {
  const s = data.value?.admin?.stats;

  if (!s) return managerStats.value;

  return [
    {
      label: "Organisations",
      value: s.organizations,
      hint: s.newOrganizations ? `+${s.newOrganizations} en 30 jours` : "Aucune nouvelle en 30 jours",
      trend: s.newOrganizations > 0,
      icon: Building2,
      tone: "bg-brand-soft text-foreground",
      to: "/admin/orgs",
    },
    {
      label: "Utilisateurs",
      value: s.users,
      hint: s.newUsers ? `+${s.newUsers} en 30 jours` : "Aucun nouveau en 30 jours",
      trend: s.newUsers > 0,
      icon: Users,
      tone: "bg-brand-soft text-foreground",
      to: "/admin/users",
    },
    {
      label: "Invitations en attente",
      value: s.pendingInvitations,
      hint: s.staleInvitations ? `${s.staleInvitations} depuis plus de 3 jours` : "Aucune en retard",
      warn: s.staleInvitations > 0,
      icon: MailPlus,
      tone: "bg-brand-soft text-foreground",
      to: "/admin/orgs",
    },
    {
      label: "Comptes suspendus",
      value: s.bannedUsers,
      hint: s.bannedUsers ? "À vérifier" : "Aucun compte suspendu",
      icon: ShieldAlert,
      tone: "bg-brand-soft text-foreground",
      to: "/admin/users",
    },
  ];
});

const signups = computed(() => {
  const weeks = data.value?.admin?.signups ?? [];
  const max = Math.max(1, ...weeks.map((w) => w.count));

  return weeks.map((w) => ({ ...w, height: Math.max(4, Math.round((w.count / max) * 100)) }));
});
const signupTotal = computed(() => signups.value.reduce((n, w) => n + w.count, 0));
const weekLabel = (iso: string) =>
  new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" }).format(new Date(iso));

const appShare = computed(() => {
  const d = data.value?.admin;

  if (!d) return [];
  const total = Math.max(1, d.stats.organizations);

  return d.appAccess.map((a) => ({ ...a, percent: Math.round((a.organizations / total) * 100) }));
});

onMounted(async () => {
  try {
    const ctx = await loadContext().catch(() => null);
    const [dashboard, org] = await Promise.all([
      $fetch<Dashboard>("/api/dashboard"),
      ctx?.active?.canManage ? $fetch<OrganizationInsights>("/api/account/organization").catch(() => null) : null,
    ]);

    insights.value = org;
    data.value = dashboard;
  } catch (e) {
    error.value = errorMessage((e as { data?: unknown }).data ?? e);
  }
});
</script>

<template>
  <div class="space-y-6">
    <FormAlert :message="error" />

    <DashboardSkeleton v-if="!data && !error" />

    <template v-else-if="data && hero">
      <section class="bg-brand-deep relative overflow-hidden rounded-xl px-6 py-7 text-white sm:px-8">
        <div class="pointer-events-none absolute -top-24 -right-16 size-72 rounded-full border border-white/10" />

        <div class="pointer-events-none absolute -top-10 -right-4 size-44 rounded-full border border-white/10" />

        <div class="relative flex flex-wrap items-end justify-between gap-6">
          <div class="space-y-2">
            <span class="inline-flex rounded-full bg-white/10 px-2.5 py-0.5 text-xs font-medium text-white/80">
              {{ profile }}
            </span>

            <h1 class="text-2xl font-semibold tracking-tight">Bonjour{{ firstName ? `, ${firstName}` : "" }}</h1>

            <p class="text-sm text-white/70">{{ hero.message }}</p>
          </div>

          <div
            v-if="hero.actions.length"
            class="flex flex-wrap gap-2"
          >
            <component
              :is="'href' in action ? 'a' : resolveComponent('NuxtLink')"
              v-for="action in hero.actions"
              :key="action.label"
              v-bind="'href' in action ? { href: action.href, target: '_blank', rel: 'noopener' } : { to: action.to }"
              class="inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors"
              :class="
                action.primary
                  ? 'text-brand-deep bg-white hover:bg-white/90'
                  : 'bg-white/10 text-white hover:bg-white/15'
              "
            >
              <component
                :is="action.icon"
                class="size-4"
              />
              {{ action.label }}
            </component>
          </div>
        </div>
      </section>

      <section
        v-if="stats.length"
        class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        <NuxtLink
          v-for="stat in stats"
          :key="stat.label"
          :to="stat.to"
          class="bg-card hover:border-foreground/15 rounded-xl border p-5 shadow-sm transition-all hover:shadow-md"
        >
          <div class="flex items-center justify-between">
            <span class="text-muted-foreground text-sm">{{ stat.label }}</span>

            <span
              class="flex size-8 items-center justify-center rounded-lg"
              :class="stat.tone"
            >
              <component
                :is="stat.icon"
                class="size-4"
              />
            </span>
          </div>

          <p class="mt-3 text-3xl font-semibold tracking-tight tabular-nums">{{ stat.value }}</p>

          <p
            class="mt-1 text-xs"
            :class="stat.warn ? 'text-amber-700' : stat.trend ? 'text-emerald-700' : 'text-muted-foreground'"
          >
            {{ stat.hint }}
          </p>
        </NuxtLink>
      </section>

      <section
        v-if="data.admin"
        class="grid gap-4 lg:grid-cols-3"
      >
        <Card class="min-w-0 lg:col-span-2">
          <CardHeader>
            <CardTitle>Nouveaux utilisateurs</CardTitle>

            <CardDescription>{{ plural(signupTotal, "inscription") }} sur les 12 dernières semaines</CardDescription>
          </CardHeader>

          <CardContent>
            <div class="flex h-40 items-end gap-1.5">
              <div
                v-for="(week, i) in signups"
                :key="week.week"
                class="group relative flex h-full flex-1 items-end"
                :title="`Semaine du ${weekLabel(week.week)} : ${plural(week.count, 'inscription')}`"
              >
                <div
                  class="w-full rounded-md transition-colors"
                  :class="i === signups.length - 1 ? 'bg-brand' : 'bg-brand/15 group-hover:bg-brand/35'"
                  :style="{ height: `${week.height}%` }"
                />
              </div>
            </div>

            <div class="text-muted-foreground mt-2 flex justify-between text-xs">
              <span>{{ signups[0] ? weekLabel(signups[0].week) : "" }}</span>

              <span>Cette semaine</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Accès par application</CardTitle>

            <CardDescription>Part des organisations autorisées</CardDescription>
          </CardHeader>

          <CardContent class="space-y-5">
            <div
              v-for="app in appShare"
              :key="app.id"
              class="space-y-2"
            >
              <div class="flex items-center justify-between text-sm">
                <span class="flex items-center gap-2 font-medium">
                  <span
                    class="flex size-6 items-center justify-center rounded-md"
                    :class="appStyle(app.id).tile"
                  >
                    <component
                      :is="appStyle(app.id).icon"
                      class="size-3.5"
                    />
                  </span>
                  {{ app.label }}
                </span>

                <span class="text-muted-foreground tabular-nums">{{ app.organizations }} · {{ app.percent }} %</span>
              </div>

              <div class="bg-muted h-2 overflow-hidden rounded-full">
                <div
                  class="bg-brand h-full rounded-full"
                  :style="{ width: `${app.percent}%` }"
                />
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      <div class="grid gap-4 lg:grid-cols-3">
        <div
          v-if="data.apps.length || data.organization || !isAdmin"
          class="min-w-0 space-y-4"
          :class="activity ? 'lg:col-span-2' : 'lg:col-span-3'"
        >
          <Card v-if="data.apps.length">
            <CardHeader>
              <CardTitle>Mes applications</CardTitle>

              <CardDescription>
                Ce que {{ data.organization?.name ?? "votre organisation" }} vous permet d'ouvrir.
              </CardDescription>
            </CardHeader>

            <CardContent class="grid gap-3 sm:grid-cols-2">
              <a
                v-for="app in data.apps"
                :key="app.id"
                :href="app.url"
                target="_blank"
                rel="noopener"
                class="hover:border-foreground/15 group flex items-center gap-3 rounded-xl border p-4 transition-all hover:shadow-sm"
              >
                <span
                  class="flex size-10 items-center justify-center rounded-lg"
                  :class="appStyle(app.id).tile"
                >
                  <component
                    :is="appStyle(app.id).icon"
                    class="size-5"
                  />
                </span>

                <div class="flex-1">
                  <p class="font-medium">{{ app.label }}</p>

                  <p class="text-muted-foreground text-xs">
                    {{ app.permissions.map((a) => actionLabel(app.id, a)).join(" · ") }}
                  </p>
                </div>

                <ArrowUpRight class="text-muted-foreground group-hover:text-foreground size-4 transition-colors" />
              </a>
            </CardContent>
          </Card>

          <Card v-if="data.organization">
            <CardHeader>
              <CardTitle>Organisation active</CardTitle>

              <CardDescription>Tout ce que vous faites ici concerne uniquement cette organisation.</CardDescription>
            </CardHeader>

            <CardContent>
              <div class="flex flex-wrap items-center gap-4">
                <span
                  class="bg-brand-soft flex size-12 shrink-0 items-center justify-center rounded-xl border text-lg font-semibold"
                >
                  {{ data.organization.name[0]?.toUpperCase() }}
                </span>

                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-2">
                    <p class="truncate font-medium">{{ data.organization.name }}</p>

                    <Badge variant="outline">{{ roleLabel(data.organization.role) }}</Badge>
                  </div>

                  <p class="text-muted-foreground text-xs">
                    {{ plural(data.organization.memberCount, "membre") }}
                    <template v-if="data.organization.apps.length">· {{ data.organization.apps.join(", ") }}</template>

                    <template v-if="data.organization.pendingInvitations">
                      · {{ plural(data.organization.pendingInvitations, "invitation") }} en attente
                    </template>
                  </p>
                </div>

                <div class="flex flex-wrap gap-2">
                  <Button
                    v-if="(context?.organizations.length ?? 0) > 1"
                    variant="outline"
                    size="sm"
                    as-child
                  >
                    <NuxtLink :to="{ path: '/select-organization', query: { callbackURL: '/' } }">Changer</NuxtLink>
                  </Button>

                  <Button
                    v-if="canManage"
                    size="sm"
                    as-child
                  >
                    <NuxtLink to="/org">
                      Gérer
                      <ChevronRight />
                    </NuxtLink>
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card v-else-if="!isAdmin">
            <CardContent class="text-muted-foreground py-8 text-center text-sm">
              Vous n'êtes membre d'aucune organisation pour l'instant.
            </CardContent>
          </Card>
        </div>

        <Card
          v-if="activity"
          class="min-w-0 self-start"
          :class="{ 'lg:col-span-3': !data.apps.length && !data.organization }"
        >
          <CardHeader>
            <CardTitle>Activité récente</CardTitle>

            <CardDescription>
              {{
                data.admin ? "Dernières actions enregistrées." : `Derniers changements dans ${data.organization?.name}.`
              }}
            </CardDescription>
          </CardHeader>

          <CardContent>
            <p
              v-if="!activity.length"
              class="text-muted-foreground py-6 text-center text-sm"
            >
              Aucune activité pour l'instant.
            </p>

            <ol
              v-else
              class="relative space-y-4 before:absolute before:top-2 before:bottom-2 before:left-[3px] before:w-px before:bg-border"
            >
              <li
                v-for="entry in activity"
                :key="entry.id"
                class="relative flex gap-3"
              >
                <span class="bg-brand ring-card mt-1.5 size-[7px] shrink-0 rounded-full ring-4" />

                <div class="min-w-0">
                  <p class="text-sm font-medium">{{ AUDIT_LABELS[entry.action] ?? entry.action }}</p>

                  <p class="text-muted-foreground truncate text-xs">
                    {{ entry.actorName || entry.actorEmail || "Système" }} · {{ formatDate(entry.createdAt) }}
                  </p>
                </div>
              </li>
            </ol>

            <Button
              variant="outline"
              size="sm"
              class="mt-5 w-full"
              as-child
            >
              <NuxtLink :to="data.admin ? '/admin/audit' : '/org/activity'">
                {{ data.admin ? "Voir le journal" : "Voir toute l'activité" }}
              </NuxtLink>
            </Button>
          </CardContent>
        </Card>
      </div>
    </template>
  </div>
</template>
