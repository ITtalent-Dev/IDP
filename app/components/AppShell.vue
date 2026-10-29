<script setup lang="ts">
import {
  Archive,
  BookOpen,
  Building2,
  Cable,
  Check,
  ChevronRight,
  ChevronsUpDown,
  History,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  ScrollText,
  Settings,
  User,
  Users,
  X,
} from "lucide-vue-next";
import type { Component } from "vue";
import { toast } from "vue-sonner";
import { authClient, isGlobalAdmin } from "~/lib/auth-client";
import { errorMessage } from "~/lib/errors";

const session = authClient.useSession();
const route = useRoute();
const isAdmin = computed(() => isGlobalAdmin(session.value.data?.user));
const open = ref(false);
const { context, load: loadContext, switchOrganization, signOut } = useAccountContext();

onMounted(() => loadContext().catch(() => undefined));

async function selectOrganization(organizationId: string) {
  if (organizationId === context.value?.active?.id) return;
  try {
    await switchOrganization(organizationId);
    window.location.href = "/";
  } catch (e) {
    toast.error(errorMessage(e));
  }
}

watch(
  () => route.fullPath,
  () => {
    open.value = false;
  },
);

interface NavLink {
  to: string;
  label: string;
  icon: Component;
  external?: boolean;
  home?: string;
  children?: { to: string; label: string; icon: Component }[];
}

const GROUPS = ["/org", "/account"];
const inGroup = (path: string, group: string) => path === group || path.startsWith(`${group}/`);
const expanded = ref<Record<string, boolean>>(Object.fromEntries(GROUPS.map((g) => [g, inGroup(route.path, g)])));

watch(
  () => route.path,
  (path) => {
    for (const g of GROUPS) expanded.value[g] = inGroup(path, g);
  },
);

function toggleGroup(link: NavLink) {
  if (expanded.value[link.to]) expanded.value[link.to] = false;
  else {
    expanded.value[link.to] = true;
    navigateTo(link.home ?? link.to);
  }
}

const organizationLinks = computed(() => {
  const active = context.value?.active;

  return [
    ...(active?.canManage
      ? [
          { to: "/org", label: "Personnes", icon: Users },
          { to: "/org/roles", label: "Rôles", icon: KeyRound },
        ]
      : []),
    ...(active?.canManageConnectors ? [{ to: "/org/connectors", label: "Appareils", icon: Cable }] : []),
    ...(active?.canManage
      ? [
          { to: "/org/activity", label: "Activité", icon: History },
          { to: "/org/settings", label: "Paramètres", icon: Settings },
        ]
      : []),
  ];
});

const sections = computed<{ label: string; links: NavLink[] }[]>(() => [
  {
    label: "",
    links: [
      { to: "/", label: "Tableau de bord", icon: LayoutDashboard },
      ...(organizationLinks.value.length
        ? [
            {
              to: "/org",
              home: organizationLinks.value[0]!.to,
              label: "Organisation",
              icon: Building2,
              children: organizationLinks.value,
            },
          ]
        : []),
      {
        to: "/account",
        label: "Mon compte",
        icon: User,
        children: [
          { to: "/account", label: "Profil", icon: User },
          { to: "/account/security", label: "Sécurité", icon: KeyRound },
          { to: "/account/sessions", label: "Sessions", icon: History },
        ],
      },
    ],
  },
  ...(isAdmin.value
    ? [
        {
          label: "Administration",
          links: [
            { to: "/admin/orgs", label: "Organisations", icon: Building2 },
            { to: "/admin/users", label: "Utilisateurs", icon: Users },
            { to: "/admin/audit", label: "Journal", icon: ScrollText },
            { to: "/admin/archives", label: "Archives", icon: Archive },
            { to: "/api/auth/reference", label: "Documentation API", icon: BookOpen, external: true },
          ],
        },
      ]
    : []),
]);

const initials = computed(() => {
  const user = session.value.data?.user;

  return (user?.name || user?.email || "")
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
});
</script>

<template>
  <div class="bg-muted/60 flex min-h-screen">
    <header
      class="bg-background/80 fixed inset-x-0 top-0 z-30 flex h-14 items-center gap-2 border-b px-3 backdrop-blur lg:hidden"
    >
      <Button
        variant="ghost"
        size="icon"
        aria-label="Ouvrir le menu"
        @click="open = true"
      >
        <Menu class="size-5" />
      </Button>

      <span class="text-sm font-semibold">Auth</span>
    </header>

    <Transition
      enter-active-class="transition-opacity duration-200"
      leave-active-class="transition-opacity duration-200"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        class="fixed inset-0 z-40 bg-black/30 lg:hidden"
        @click="open = false"
      />
    </Transition>

    <aside
      class="bg-muted fixed inset-y-0 left-0 z-50 flex w-64 flex-col transition-transform duration-200 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 lg:bg-transparent"
      :class="open ? 'translate-x-0' : '-translate-x-full'"
    >
      <div class="mx-3 flex h-16 items-center justify-between gap-2 border-b">
        <DropdownMenu v-if="context?.active && context.organizations.length > 1">
          <DropdownMenuTrigger
            class="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-lg p-1.5 text-left transition-colors hover:bg-black/[0.04] data-[state=open]:bg-black/[0.04]"
            aria-label="Changer d'organisation"
          >
            <OrgLogo
              v-if="context.active.logoUrl"
              :name="context.active.name"
              :logo-url="context.active.logoUrl"
              class="bg-background size-8"
            />

            <span
              v-else
              class="bg-brand text-brand-foreground flex size-8 shrink-0 items-center justify-center rounded-lg shadow-sm"
            >
              <KeyRound class="size-4" />
            </span>

            <span class="flex min-w-0 flex-1 flex-col leading-tight">
              <span class="text-sm font-semibold">Auth</span>

              <span class="text-muted-foreground truncate text-xs">{{ context.active.name }}</span>
            </span>

            <ChevronsUpDown class="text-muted-foreground size-4 shrink-0" />
          </DropdownMenuTrigger>

          <DropdownMenuContent
            align="start"
            class="w-60"
          >
            <DropdownMenuLabel>Organisations</DropdownMenuLabel>

            <DropdownMenuItem
              v-for="org in context.organizations"
              :key="org.id"
              @select="selectOrganization(org.id)"
            >
              <OrgLogo
                :name="org.name"
                :logo-url="org.logoUrl"
                class="size-6 rounded text-xs"
              />

              <span class="flex-1 truncate">{{ org.name }}</span>

              <Check
                v-if="org.id === context.active.id"
                class="!text-foreground"
              />
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <NuxtLink
          v-else
          to="/"
          class="flex min-w-0 items-center gap-2.5 p-1.5"
        >
          <OrgLogo
            v-if="!isAdmin && context?.active?.logoUrl"
            :name="context.active.name"
            :logo-url="context.active.logoUrl"
            class="bg-background size-8"
          />

          <span
            v-else
            class="bg-brand text-brand-foreground flex size-8 shrink-0 items-center justify-center rounded-lg shadow-sm"
          >
            <KeyRound class="size-4" />
          </span>

          <span class="flex min-w-0 flex-col leading-tight">
            <span class="text-sm font-semibold">Auth</span>

            <span class="text-muted-foreground truncate text-xs">
              {{ isAdmin ? "Administration" : (context?.active?.name ?? "Espace client") }}
            </span>
          </span>
        </NuxtLink>

        <Button
          variant="ghost"
          size="icon"
          class="lg:hidden"
          aria-label="Fermer le menu"
          @click="open = false"
        >
          <X class="size-5" />
        </Button>
      </div>

      <nav class="flex-1 space-y-6 overflow-y-auto px-3 py-4">
        <div
          v-for="section in sections"
          :key="section.label"
          class="space-y-1"
        >
          <p
            v-if="section.label"
            class="text-muted-foreground/80 px-2.5 pb-1 text-[11px] font-medium tracking-wider uppercase"
          >
            {{ section.label }}
          </p>

          <template
            v-for="link in section.links"
            :key="link.to"
          >
            <div v-if="link.children">
              <button
                type="button"
                class="text-muted-foreground hover:text-foreground flex w-full cursor-pointer items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-1.5 text-sm transition-colors hover:bg-black/[0.04]"
                :class="{ '!text-foreground font-medium': inGroup(route.path, link.to) }"
                :aria-expanded="expanded[link.to]"
                @click="toggleGroup(link)"
              >
                <component
                  :is="link.icon"
                  class="size-4 opacity-70"
                />

                <span class="flex-1 text-left">{{ link.label }}</span>

                <ChevronRight
                  class="size-3.5 opacity-60 transition-transform"
                  :class="{ 'rotate-90': expanded[link.to] }"
                />
              </button>

              <div
                class="grid transition-[grid-template-rows] duration-200"
                :class="expanded[link.to] ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'"
              >
                <div class="overflow-hidden">
                  <div class="border-border mt-1 ml-[18px] space-y-0.5 border-l pl-2">
                    <NuxtLink
                      v-for="child in link.children"
                      :key="child.to"
                      :to="child.to"
                      class="text-muted-foreground hover:text-foreground flex items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-sm transition-colors hover:bg-black/[0.04]"
                      exact-active-class="!bg-background !text-foreground !border-border font-medium shadow-sm"
                    >
                      {{ child.label }}
                    </NuxtLink>
                  </div>
                </div>
              </div>
            </div>

            <NuxtLink
              v-else
              :to="link.to"
              :external="link.external"
              :target="link.external ? '_blank' : undefined"
              class="group text-muted-foreground hover:text-foreground flex items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-1.5 text-sm transition-colors hover:bg-black/[0.04]"
              exact-active-class="!bg-background !text-foreground !border-border font-medium shadow-sm"
            >
              <component
                :is="link.icon"
                class="size-4 opacity-70 group-[.router-link-exact-active]:opacity-100"
              />
              {{ link.label }}
            </NuxtLink>
          </template>
        </div>
      </nav>

      <div class="mx-3 flex items-center gap-2.5 border-t py-3">
        <span
          class="bg-background flex size-8 shrink-0 items-center justify-center rounded-md border text-xs font-medium shadow-sm"
        >
          {{ initials }}
        </span>

        <span class="flex min-w-0 flex-1 flex-col">
          <span class="truncate text-sm font-medium">{{ session.data?.user.name }}</span>

          <span class="text-muted-foreground truncate text-xs">{{ session.data?.user.email }}</span>
        </span>

        <Button
          variant="ghost"
          size="icon"
          class="size-8 shrink-0"
          aria-label="Se déconnecter"
          title="Se déconnecter"
          @click="signOut"
        >
          <LogOut class="size-4" />
        </Button>
      </div>
    </aside>

    <main class="min-w-0 flex-1 pt-14 lg:py-2 lg:pr-2 lg:pt-2">
      <div class="bg-background min-h-full lg:rounded-xl lg:border lg:shadow-sm">
        <div class="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-8">
          <slot />
        </div>
      </div>
    </main>
  </div>
</template>
