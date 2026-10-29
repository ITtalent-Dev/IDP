<script setup lang="ts">
import { toast } from "vue-sonner";
import { Cable, Ellipsis, Pencil, Unplug } from "lucide-vue-next";
import { errorMessage } from "~/lib/errors";
import { connectorKindLabel, formatDate } from "~/lib/labels";
import type { ConnectorPage, OrgConnector } from "~/lib/org";

const PAGE_SIZE = 25;

const props = defineProps<{ endpoint: string; canRename: boolean; canRevoke: boolean }>();

const page = ref(0);
const data = ref<ConnectorPage | null>(null);
const error = ref("");
const busy = ref(false);
const target = ref<OrgConnector | null>(null);
const renameOpen = ref(false);
const revokeOpen = ref(false);
const newName = ref("");

const canAct = (c: OrgConnector) => c.status === "active" && (props.canRename || props.canRevoke);
const creatorLabel = (c: OrgConnector) => c.createdBy?.name || c.createdBy?.email || "Compte supprimé";

async function load() {
  try {
    data.value = await $fetch<ConnectorPage>(props.endpoint, {
      query: { limit: PAGE_SIZE, offset: page.value * PAGE_SIZE },
    });
    error.value = "";
  } catch (e) {
    error.value = errorMessage((e as { data?: unknown }).data ?? e);
  }
}

watch(page, load);
watch(
  () => props.endpoint,
  () => (page.value === 0 ? load() : (page.value = 0)),
);
onMounted(load);
defineExpose({ reload: load });

function askRename(c: OrgConnector) {
  target.value = c;
  newName.value = c.name;
  renameOpen.value = true;
}

function askRevoke(c: OrgConnector) {
  target.value = c;
  revokeOpen.value = true;
}

async function run(action: () => Promise<unknown>, success: string) {
  busy.value = true;
  try {
    await action();
    toast.success(success);
    renameOpen.value = false;
    revokeOpen.value = false;
    await load();
  } catch (e) {
    toast.error(errorMessage((e as { data?: unknown }).data ?? e));
  } finally {
    busy.value = false;
  }
}

const itemUrl = (): string => `${props.endpoint}/${target.value!.id}`;

const rename = () =>
  run(
    () => $fetch<{ renamed: boolean }>(itemUrl(), { method: "PATCH", body: { name: newName.value.trim() } }),
    "Connecteur renommé.",
  );

const revoke = () => run(() => $fetch<{ revoked: boolean }>(itemUrl(), { method: "DELETE" }), "Connecteur révoqué.");
</script>

<template>
  <div>
    <FormAlert
      v-if="error"
      :message="error"
    />

    <div
      v-else
      class="bg-card overflow-hidden rounded-xl border shadow-sm"
    >
      <Table>
        <TableHeader>
          <TableRow class="hover:bg-transparent">
            <TableHead class="pl-4">Machine</TableHead>

            <TableHead>Statut</TableHead>

            <TableHead class="hidden md:table-cell">Appairé par</TableHead>

            <TableHead class="hidden sm:table-cell">Dernière connexion</TableHead>

            <TableHead class="w-12" />
          </TableRow>
        </TableHeader>

        <TableBody>
          <TableRow v-if="!data">
            <TableCell
              colspan="5"
              class="text-muted-foreground py-8 text-center"
            >
              Chargement…
            </TableCell>
          </TableRow>

          <TableRow v-else-if="!data.connectors.length">
            <TableCell
              colspan="5"
              class="text-muted-foreground py-8 text-center"
            >
              Aucun connecteur pour le moment.
            </TableCell>
          </TableRow>

          <TableRow
            v-for="c in data?.connectors ?? []"
            :key="c.id"
          >
            <TableCell class="pl-4">
              <div class="flex items-center gap-3">
                <span class="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
                  <Cable class="size-4" />
                </span>

                <div class="min-w-0">
                  <p class="truncate font-medium">{{ c.name }}</p>

                  <p class="text-muted-foreground text-xs">
                    {{ connectorKindLabel(c.kind) }} · appairé le {{ formatDate(c.createdAt) }}
                  </p>
                </div>
              </div>
            </TableCell>

            <TableCell>
              <Badge :variant="c.status === 'active' ? 'success' : 'secondary'">
                {{ c.status === "active" ? "Actif" : "Révoqué" }}
              </Badge>

              <p
                v-if="c.revokedAt"
                class="text-muted-foreground mt-1 text-xs"
              >
                le {{ formatDate(c.revokedAt) }}
              </p>
            </TableCell>

            <TableCell class="text-muted-foreground hidden md:table-cell">{{ creatorLabel(c) }}</TableCell>

            <TableCell class="text-muted-foreground hidden sm:table-cell">
              {{ c.lastUsedAt ? formatDate(c.lastUsedAt) : "Jamais" }}
            </TableCell>

            <TableCell class="pr-3 text-right">
              <DropdownMenu v-if="canAct(c)">
                <DropdownMenuTrigger as-child>
                  <Button
                    variant="ghost"
                    size="icon"
                    class="size-8"
                    :aria-label="`Actions pour le connecteur ${c.name}`"
                  >
                    <Ellipsis />
                  </Button>
                </DropdownMenuTrigger>

                <DropdownMenuContent>
                  <DropdownMenuLabel>{{ c.name }}</DropdownMenuLabel>

                  <DropdownMenuItem
                    v-if="canRename"
                    @select="askRename(c)"
                  >
                    <Pencil />
                    Renommer
                  </DropdownMenuItem>

                  <DropdownMenuSeparator v-if="canRename && canRevoke" />

                  <DropdownMenuItem
                    v-if="canRevoke"
                    variant="destructive"
                    @select="askRevoke(c)"
                  >
                    <Unplug />
                    Révoquer
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>

      <TablePagination
        v-if="data"
        v-model="page"
        :total="data.total"
        :page-size="PAGE_SIZE"
      />
    </div>

    <Dialog v-model:open="renameOpen">
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle>Renommer le connecteur</DialogTitle>

          <DialogDescription>Le nouveau nom s'affiche dans la liste et le journal d'activité.</DialogDescription>
        </DialogHeader>

        <form
          class="grid gap-4"
          @submit.prevent="rename"
        >
          <FormField
            v-model="newName"
            label="Nom"
            required
            :minlength="1"
          />

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              @click="renameOpen = false"
            >
              Annuler
            </Button>

            <Button
              type="submit"
              :disabled="busy || !newName.trim() || newName.trim() === target?.name"
            >
              Renommer
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <ConfirmDialog
      v-model:open="revokeOpen"
      :title="`Révoquer « ${target?.name ?? ''} » ?`"
      description="La machine ne pourra plus obtenir de jeton : ses imports s'arrêteront au plus tard à l'expiration de son jeton en cours. Pour la reconnecter, il faudra l'appairer à nouveau."
      confirm-label="Révoquer"
      destructive
      :loading="busy"
      @confirm="revoke"
    />
  </div>
</template>
