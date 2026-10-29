<script setup lang="ts">
import { toast } from "vue-sonner";
import { errorMessage } from "~/lib/errors";
import { Trash2 } from "lucide-vue-next";
import { formatDate, roleLabel, roleOptions } from "~/lib/labels";
import type { OrgInvitation, OrgMember } from "~/lib/org";

interface OrgDetailResponse {
  organization: {
    id: string;
    name: string;
    slug: string;
    apps: string[] | null;
    requireTwoFactor: boolean | null;
    createdAt: string;
    logoUrl: string | null;
  };
  roles: string[];
  counts: { members: number; pendingInvitations: number };
}

const props = defineProps<{ id: string }>();
const emit = defineEmits<{ changed: []; deleted: [] }>();

const detail = ref<OrgDetailResponse | null>(null);
const apps = ref<string[]>([]);
const inviteEmail = ref("");
const inviteRole = ref("owner");
const saving = ref(false);
const deleteOpen = ref(false);
const deleteConfirm = ref("");
const deleting = ref(false);
const tab = ref("members");

const peopleEndpoint = () => `/api/admin/organizations/${props.id}/people`;
const members = usePeoplePage(peopleEndpoint, ref("members"), 20);
const invitations = usePeoplePage(peopleEndpoint, ref("pending"), 20);
const memberRows = computed(() => (members.data.value?.rows ?? []).filter((r): r is OrgMember => r.kind === "member"));
const invitationRows = computed(() =>
  (invitations.data.value?.rows ?? []).filter((r): r is OrgInvitation => r.kind === "invitation"),
);

const appsChanged = computed(() => {
  const saved = [...(detail.value?.organization.apps ?? [])].sort().join();

  return saved !== [...apps.value].sort().join();
});

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");

const fail = (e: unknown) => toast.error(errorMessage((e as { data?: unknown }).data ?? e));

async function load() {
  try {
    detail.value = await $fetch<OrgDetailResponse>(`/api/admin/organizations/${props.id}`);
    apps.value = detail.value.organization.apps ?? [];
  } catch (e) {
    fail(e);
  }
}

async function saveApps() {
  saving.value = true;
  try {
    await $fetch(`/api/admin/organizations/${props.id}`, { method: "PATCH", body: { apps: apps.value } });
    toast.success("Applications autorisées mises à jour.");
    emit("changed");
    await load();
  } catch (e) {
    fail(e);
  } finally {
    saving.value = false;
  }
}

async function setTwoFactor(value: boolean) {
  try {
    await $fetch(`/api/admin/organizations/${props.id}`, { method: "PATCH", body: { requireTwoFactor: value } });
    toast.success(value ? "Double authentification obligatoire." : "Double authentification facultative.");
    emit("changed");
    await load();
  } catch (e) {
    fail(e);
  }
}

async function invite() {
  try {
    await $fetch(`/api/admin/organizations/${props.id}/invitations`, {
      method: "POST",
      body: { email: inviteEmail.value, role: inviteRole.value },
    });
    toast.success(`Invitation envoyée à ${inviteEmail.value}.`);
    inviteEmail.value = "";
    emit("changed");
    await Promise.all([load(), invitations.load()]);
  } catch (e) {
    fail(e);
  }
}

async function deleteOrganization() {
  deleting.value = true;
  try {
    await $fetch(`/api/admin/organizations/${props.id}`, { method: "DELETE", body: { confirm: deleteConfirm.value } });
    toast.success(`${detail.value?.organization.name ?? "L'organisation"} a été supprimée.`);
    deleteOpen.value = false;
    emit("deleted");
  } catch (e) {
    fail(e);
  } finally {
    deleting.value = false;
  }
}

watch(() => props.id, load, { immediate: true });
</script>

<template>
  <div class="flex flex-1 flex-col">
    <PageLoader v-if="!detail" />

    <template v-else>
      <SheetHeader>
        <div class="flex items-center gap-3">
          <OrgLogo
            :name="detail.organization.name"
            :logo-url="detail.organization.logoUrl"
            class="size-11 rounded-xl text-lg"
          />

          <div class="min-w-0">
            <SheetTitle class="truncate">{{ detail.organization.name }}</SheetTitle>

            <SheetDescription>
              {{ detail.organization.slug }} · créée le {{ formatDate(detail.organization.createdAt) }}
            </SheetDescription>
          </div>
        </div>
      </SheetHeader>

      <SheetBody>
        <section class="space-y-3">
          <div>
            <h3 class="text-sm font-semibold">Applications autorisées</h3>

            <p class="text-muted-foreground text-xs">Les rôles de l'organisation ne peuvent pas dépasser ce plafond.</p>
          </div>

          <div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
            <AdminAppsPicker v-model="apps" />

            <Button
              size="sm"
              :disabled="!appsChanged || saving"
              @click="saveApps"
            >
              Enregistrer
            </Button>
          </div>
        </section>

        <section class="space-y-3">
          <h3 class="text-sm font-semibold">Sécurité</h3>

          <div class="flex items-center justify-between gap-4 rounded-lg border p-3">
            <div>
              <p class="text-sm">Exiger la double authentification</p>

              <p class="text-muted-foreground text-xs">Le gérant peut aussi modifier ce réglage.</p>
            </div>

            <Switch
              :model-value="detail.organization.requireTwoFactor === true"
              aria-label="Exiger la double authentification"
              @update:model-value="setTwoFactor"
            />
          </div>
        </section>

        <Tabs
          v-model="tab"
          class="gap-4"
        >
          <TabsList class="w-full">
            <TabsTrigger value="members">Membres · {{ detail.counts.members }}</TabsTrigger>

            <TabsTrigger value="invitations">Invitations · {{ detail.counts.pendingInvitations }}</TabsTrigger>

            <TabsTrigger value="connectors">Appareils</TabsTrigger>
          </TabsList>

          <TabsContent
            value="members"
            class="space-y-3"
          >
            <SearchInput
              v-if="detail.counts.members > 5"
              v-model="members.q.value"
              placeholder="Rechercher un membre"
              class="sm:max-w-none"
            />

            <PageLoader v-if="!members.data.value" />

            <p
              v-else-if="!detail.counts.members"
              class="text-muted-foreground rounded-lg border border-dashed p-4 text-center text-sm"
            >
              Aucun membre pour l'instant.
            </p>

            <p
              v-else-if="!memberRows.length"
              class="text-muted-foreground p-4 text-center text-sm"
            >
              Aucun membre ne correspond.
            </p>

            <div
              v-else
              class="overflow-hidden rounded-lg border"
              :class="members.loading.value && 'opacity-60'"
            >
              <ul class="divide-y">
                <li
                  v-for="m in memberRows"
                  :key="m.id"
                  class="flex items-center gap-3 px-3 py-2.5"
                >
                  <span
                    class="bg-muted flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-medium"
                  >
                    {{ initials(m.user.name || m.user.email) }}
                  </span>

                  <div class="min-w-0 flex-1">
                    <p class="truncate text-sm font-medium">{{ m.user.name }}</p>

                    <p class="text-muted-foreground truncate text-xs">{{ m.user.email }}</p>
                  </div>

                  <TwoFactorBadge
                    :enabled="m.twoFactor"
                    :required="detail.organization.requireTwoFactor === true"
                  />

                  <Badge variant="outline">{{ roleLabel(m.role) }}</Badge>
                </li>
              </ul>

              <TablePagination
                v-model="members.page.value"
                :total="members.data.value.total"
                :page-size="members.pageSize"
              />
            </div>
          </TabsContent>

          <TabsContent
            value="invitations"
            class="space-y-4"
          >
            <form
              class="grid gap-2 sm:grid-cols-[1fr_10rem_auto] sm:items-end"
              @submit.prevent="invite"
            >
              <FormField
                v-model="inviteEmail"
                label="Inviter une personne"
                type="email"
                placeholder="nom@entreprise.fr"
                required
              />

              <AppSelect
                v-model="inviteRole"
                :options="roleOptions(detail.roles)"
                aria-label="Rôle"
              />

              <Button
                type="submit"
                variant="outline"
              >
                Inviter
              </Button>
            </form>

            <PageLoader v-if="!invitations.data.value" />

            <p
              v-else-if="!invitationRows.length"
              class="text-muted-foreground rounded-lg border border-dashed p-4 text-center text-sm"
            >
              Aucune invitation en attente.
            </p>

            <div
              v-else
              class="overflow-hidden rounded-lg border"
              :class="invitations.loading.value && 'opacity-60'"
            >
              <ul class="divide-y">
                <li
                  v-for="i in invitationRows"
                  :key="i.id"
                  class="flex items-center gap-3 px-3 py-2.5"
                >
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-sm">{{ i.email }}</p>

                    <p class="text-muted-foreground text-xs">Expire le {{ formatDate(i.expiresAt) }}</p>
                  </div>

                  <Badge variant="outline">{{ roleLabel(i.role) }}</Badge>
                </li>
              </ul>

              <TablePagination
                v-model="invitations.page.value"
                :total="invitations.data.value.total"
                :page-size="invitations.pageSize"
              />
            </div>
          </TabsContent>

          <TabsContent value="connectors">
            <OrgConnectorsTable
              :endpoint="`/api/admin/organizations/${id}/connectors`"
              :can-rename="false"
              can-revoke
            />
          </TabsContent>
        </Tabs>

        <section class="space-y-3">
          <h3 class="text-sm font-semibold">Zone sensible</h3>

          <div class="flex items-center justify-between gap-4 rounded-lg border p-3">
            <div>
              <p class="text-sm font-medium text-red-700">Supprimer l'organisation</p>

              <p class="text-muted-foreground text-xs">
                Membres, invitations et rôles sont supprimés. Les applications perdent l'accès.
              </p>
            </div>

            <Button
              variant="destructive"
              size="sm"
              @click="((deleteConfirm = ''), (deleteOpen = true))"
            >
              <Trash2 />
              Supprimer
            </Button>
          </div>
        </section>
      </SheetBody>

      <Dialog v-model:open="deleteOpen">
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Supprimer {{ detail.organization.name }} ?</DialogTitle>

            <DialogDescription>
              Cette action est définitive : {{ detail.counts.members }} membre(s) perdront immédiatement l'accès aux
              applications de l'organisation.
            </DialogDescription>
          </DialogHeader>

          <form
            class="space-y-5"
            @submit.prevent="deleteOrganization"
          >
            <FormField
              v-model="deleteConfirm"
              :label="`Tapez « ${detail.organization.slug} » pour confirmer`"
              autocomplete="off"
              required
            />

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                @click="deleteOpen = false"
              >
                Annuler
              </Button>

              <Button
                type="submit"
                variant="destructive"
                :disabled="deleting || deleteConfirm !== detail.organization.slug"
              >
                Supprimer définitivement
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </template>
  </div>
</template>
