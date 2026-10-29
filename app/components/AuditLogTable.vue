<script setup lang="ts">
import { watchDebounced } from "@vueuse/core";
import {
  Building2,
  Cable,
  Filter,
  KeyRound,
  MailPlus,
  ScrollText,
  ShieldCheck,
  ShieldOff,
  UserCog,
  Users,
  X,
} from "lucide-vue-next";
import { errorMessage } from "~/lib/errors";
import { AUDIT_LABELS, formatDate } from "~/lib/labels";

const props = defineProps<{ endpoint: string; organizationScope?: boolean }>();

interface AuditEntry {
  id: string;
  action: string;
  actorId: string | null;
  actorEmail: string | null;
  actorName: string | null;
  impersonatedBy: string | null;
  targetType: string | null;
  targetId: string | null;
  organizationId: string | null;
  organizationName: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
}

type IdFilter = "actorId" | "organizationId" | "targetId";

const PAGE_SIZE = 50;
const ICONS: Record<string, Component> = {
  impersonation: UserCog,
  organization: Building2,
  role: KeyRound,
  invitation: MailPlus,
  member: Users,
  connector: Cable,
  "user.ban": ShieldOff,
  "user.unban": ShieldCheck,
  "user.two_factor": ShieldCheck,
  "user.passkey": KeyRound,
  user: UserCog,
};
const TARGET_LABELS: Record<string, string> = {
  user: "Utilisateur",
  organization: "Organisation",
  member: "Membre",
  invitation: "Invitation",
  role: "Rôle",
  connector: "Appareil",
  connector_pairing: "Appairage",
};

const filters = reactive({ action: "", actorId: "", organizationId: "", targetId: "", from: "", to: "" });
const filterLabels = reactive<Record<IdFilter, string>>({ actorId: "", organizationId: "", targetId: "" });
const page = ref(0);
const entries = ref<AuditEntry[] | null>(null);
const total = ref(0);
const error = ref("");
const selected = ref<AuditEntry | null>(null);
const detailOpen = ref(false);

const hasFilters = computed(() => Object.values(filters).some(Boolean));
const idChips = computed(() =>
  (["actorId", "organizationId", "targetId"] as const)
    .filter((k) => filters[k])
    .map((k) => ({
      key: k,
      label: `${{ actorId: "Acteur", organizationId: "Organisation", targetId: "Cible" }[k]} : ${filterLabels[k] || filters[k]}`,
    })),
);

const ALL_ACTIONS = "__all__";
const PERIODS = [
  { value: "all", label: "Toute la période" },
  { value: "0", label: "Aujourd'hui" },
  { value: "7", label: "7 derniers jours" },
  { value: "30", label: "30 derniers jours" },
  { value: "90", label: "90 derniers jours" },
];
const period = ref("all");

function startOfPeriod(days: number) {
  const date = new Date();

  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - days);

  return date.toISOString();
}

watch(period, (value) => {
  filters.from = value === "all" ? "" : startOfPeriod(Number(value));
  filters.to = "";
});
const ORGANIZATION_ACTIONS = new Set(["organization.", "role.", "invitation.", "member.", "connector."]);
const actionOptions = computed(() =>
  Object.entries(AUDIT_LABELS).filter(
    ([value]) => !props.organizationScope || [...ORGANIZATION_ACTIONS].some((prefix) => value.startsWith(prefix)),
  ),
);

const iconFor = (action: string) =>
  ICONS[action] ?? ICONS[action.split(".").slice(0, 2).join(".")] ?? ICONS[action.split(".")[0]!] ?? ScrollText;
const actorLabel = (e: AuditEntry) => e.actorName || e.actorEmail || (e.actorId ? "Utilisateur supprimé" : "Système");
const metadataEntries = (e: AuditEntry) => Object.entries(e.metadata ?? {});
const formatValue = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

async function load() {
  const query: Record<string, string> = { limit: String(PAGE_SIZE), offset: String(page.value * PAGE_SIZE) };

  for (const [k, v] of Object.entries(filters)) if (v) query[k] = k === "to" ? `${v}T23:59:59` : v;
  try {
    const res = await $fetch<{ entries: AuditEntry[]; total: number }>(props.endpoint, { query });

    entries.value = res.entries;
    total.value = res.total;
    error.value = "";
  } catch (e) {
    error.value = errorMessage((e as { data?: unknown }).data ?? e);
  }
}

function openDetail(e: AuditEntry) {
  selected.value = e;
  detailOpen.value = true;
}

function filterBy(key: IdFilter, value: string | null, label: string | null) {
  if (!value) return;
  filters[key] = value;
  filterLabels[key] = label ?? "";
  detailOpen.value = false;
}

function clearFilter(key: IdFilter) {
  filters[key] = "";
  filterLabels[key] = "";
}

function resetFilters() {
  Object.assign(filters, { action: "", actorId: "", organizationId: "", targetId: "", from: "", to: "" });
  period.value = "all";
  Object.assign(filterLabels, { actorId: "", organizationId: "", targetId: "" });
}

watchDebounced(
  filters,
  () => {
    page.value = 0;
    load();
  },
  { debounce: 250, deep: true },
);
watch(page, load);
onMounted(load);
</script>

<template>
  <div class="space-y-6">
    <FormAlert :message="error" />

    <div class="bg-card overflow-hidden rounded-xl border shadow-sm">
      <div class="space-y-3 border-b p-3">
        <div class="flex flex-wrap items-center gap-2">
          <div class="w-full sm:w-64">
            <AppSelect
              :model-value="filters.action || ALL_ACTIONS"
              :options="[
                { value: ALL_ACTIONS, label: 'Toutes les actions' },
                ...actionOptions.map(([value, label]) => ({ value, label })),
              ]"
              aria-label="Type d'action"
              @update:model-value="(v) => (filters.action = v === ALL_ACTIONS ? '' : v)"
            />
          </div>

          <div class="w-full sm:w-52">
            <AppSelect
              v-model="period"
              :options="PERIODS"
              aria-label="Période"
            />
          </div>

          <Button
            v-if="hasFilters"
            variant="ghost"
            size="sm"
            @click="resetFilters"
          >
            <X />
            Réinitialiser
          </Button>
        </div>

        <div
          v-if="idChips.length"
          class="flex flex-wrap gap-2"
        >
          <span
            v-for="chip in idChips"
            :key="chip.key"
            class="bg-muted inline-flex max-w-full items-center gap-1.5 rounded-full py-1 pr-1 pl-3 text-xs"
          >
            <Filter class="size-3" />

            <span class="truncate">{{ chip.label }}</span>

            <button
              type="button"
              class="hover:bg-background cursor-pointer rounded-full p-0.5"
              :aria-label="`Retirer le filtre ${chip.label}`"
              @click="clearFilter(chip.key)"
            >
              <X class="size-3" />
            </button>
          </span>
        </div>
      </div>

      <PageLoader v-if="!entries" />

      <div
        v-else-if="!entries.length"
        class="flex flex-col items-center gap-2 px-6 py-14 text-center"
      >
        <span class="bg-muted flex size-10 items-center justify-center rounded-xl">
          <ScrollText class="text-muted-foreground size-5" />
        </span>

        <p class="font-medium">Aucune entrée</p>

        <p class="text-muted-foreground text-sm">
          {{ hasFilters ? "Aucune action ne correspond à ces filtres." : "Les actions sensibles apparaîtront ici." }}
        </p>
      </div>

      <template v-else>
        <Table>
          <TableHeader>
            <TableRow class="hover:bg-transparent">
              <TableHead class="pl-4">Action</TableHead>

              <TableHead>Acteur</TableHead>

              <TableHead
                v-if="!organizationScope"
                class="hidden lg:table-cell"
              >
                Organisation
              </TableHead>

              <TableHead class="text-right">Date</TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            <TableRow
              v-for="e in entries"
              :key="e.id"
              class="cursor-pointer"
              :data-state="detailOpen && selected?.id === e.id ? 'selected' : undefined"
              @click="openDetail(e)"
            >
              <TableCell class="pl-4">
                <div class="flex items-center gap-3">
                  <span class="bg-muted flex size-8 shrink-0 items-center justify-center rounded-lg">
                    <component
                      :is="iconFor(e.action)"
                      class="size-4"
                    />
                  </span>

                  <div class="min-w-0">
                    <p class="truncate font-medium">{{ AUDIT_LABELS[e.action] ?? e.action }}</p>

                    <p
                      v-if="e.targetType"
                      class="text-muted-foreground truncate text-xs"
                    >
                      {{ TARGET_LABELS[e.targetType] ?? e.targetType }}
                    </p>
                  </div>
                </div>
              </TableCell>

              <TableCell>
                <p class="truncate">{{ actorLabel(e) }}</p>

                <span
                  v-if="e.impersonatedBy"
                  class="text-xs text-amber-700"
                >
                  {{ organizationScope ? "par le support" : "via impersonation" }}
                </span>

                <p
                  v-else-if="e.actorName && e.actorEmail"
                  class="text-muted-foreground truncate text-xs"
                >
                  {{ e.actorEmail }}
                </p>
              </TableCell>

              <TableCell
                v-if="!organizationScope"
                class="hidden lg:table-cell"
              >
                <span v-if="e.organizationId">{{ e.organizationName ?? "Organisation supprimée" }}</span>

                <span
                  v-else
                  class="text-muted-foreground"
                >
                  —
                </span>
              </TableCell>

              <TableCell class="text-muted-foreground pr-4 text-right whitespace-nowrap">
                {{ formatDate(e.createdAt) }}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>

        <TablePagination
          v-model="page"
          :total="total"
          :page-size="PAGE_SIZE"
        />
      </template>
    </div>

    <Sheet v-model:open="detailOpen">
      <SheetContent>
        <template v-if="selected">
          <SheetHeader>
            <div class="flex items-center gap-3">
              <span class="bg-muted flex size-11 shrink-0 items-center justify-center rounded-xl">
                <component
                  :is="iconFor(selected.action)"
                  class="size-5"
                />
              </span>

              <div class="min-w-0">
                <SheetTitle>{{ AUDIT_LABELS[selected.action] ?? selected.action }}</SheetTitle>

                <SheetDescription>{{ formatDate(selected.createdAt) }}</SheetDescription>
              </div>
            </div>
          </SheetHeader>

          <SheetBody>
            <section class="space-y-3">
              <h3 class="text-sm font-semibold">Qui et quoi</h3>

              <dl class="divide-y rounded-lg border text-sm">
                <div class="flex items-center justify-between gap-4 px-3 py-2.5">
                  <dt class="text-muted-foreground">Acteur</dt>

                  <dd class="flex min-w-0 items-center gap-2">
                    <span class="truncate">{{ actorLabel(selected) }}</span>

                    <Button
                      v-if="selected.actorId"
                      variant="ghost"
                      size="icon"
                      class="size-7"
                      aria-label="Filtrer par cet acteur"
                      title="Filtrer par cet acteur"
                      @click="filterBy('actorId', selected.actorId, actorLabel(selected))"
                    >
                      <Filter />
                    </Button>
                  </dd>
                </div>

                <div
                  v-if="selected.impersonatedBy"
                  class="flex justify-between gap-4 px-3 py-2.5"
                >
                  <dt class="text-muted-foreground">
                    {{ organizationScope ? "Réalisé par" : "Pendant une impersonation par" }}
                  </dt>

                  <dd
                    v-if="organizationScope"
                    class="text-sm"
                  >
                    Le support, connecté en tant que ce membre
                  </dd>

                  <dd
                    v-else
                    class="truncate font-mono text-xs"
                  >
                    {{ selected.impersonatedBy }}
                  </dd>
                </div>

                <div
                  v-if="selected.organizationId && !organizationScope"
                  class="flex items-center justify-between gap-4 px-3 py-2.5"
                >
                  <dt class="text-muted-foreground">Organisation</dt>

                  <dd class="flex min-w-0 items-center gap-2">
                    <span class="truncate">{{ selected.organizationName ?? "Organisation supprimée" }}</span>

                    <Button
                      variant="ghost"
                      size="icon"
                      class="size-7"
                      aria-label="Filtrer par cette organisation"
                      title="Filtrer par cette organisation"
                      @click="filterBy('organizationId', selected.organizationId, selected.organizationName)"
                    >
                      <Filter />
                    </Button>
                  </dd>
                </div>

                <div
                  v-if="selected.targetId"
                  class="flex items-center justify-between gap-4 px-3 py-2.5"
                >
                  <dt class="text-muted-foreground">
                    Cible · {{ TARGET_LABELS[selected.targetType ?? ""] ?? selected.targetType }}
                  </dt>

                  <dd class="flex min-w-0 items-center gap-2">
                    <span class="truncate font-mono text-xs">{{ selected.targetId }}</span>

                    <Button
                      variant="ghost"
                      size="icon"
                      class="size-7"
                      aria-label="Filtrer par cette cible"
                      title="Filtrer par cette cible"
                      @click="filterBy('targetId', selected.targetId, null)"
                    >
                      <Filter />
                    </Button>
                  </dd>
                </div>
              </dl>
            </section>

            <section
              v-if="metadataEntries(selected).length"
              class="space-y-3"
            >
              <h3 class="text-sm font-semibold">Détails</h3>

              <dl class="divide-y rounded-lg border text-sm">
                <div
                  v-for="[key, value] in metadataEntries(selected)"
                  :key="key"
                  class="flex justify-between gap-4 px-3 py-2.5"
                >
                  <dt class="text-muted-foreground">{{ key }}</dt>

                  <dd class="min-w-0 text-right font-mono text-xs break-all">{{ formatValue(value) }}</dd>
                </div>
              </dl>
            </section>
          </SheetBody>
        </template>
      </SheetContent>
    </Sheet>
  </div>
</template>
