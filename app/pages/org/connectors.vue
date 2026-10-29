<script setup lang="ts">
import { Cable } from "lucide-vue-next";
import { authClient } from "~/lib/auth-client";
import { errorMessage } from "~/lib/errors";

definePageMeta({ middleware: "auth" });
useHead({ title: "Appareils" });

const { context, load } = useAccountContext();
const rights = ref<{ create: boolean; update: boolean; delete: boolean } | null>(null);
const error = ref("");

const active = computed(() => context.value?.active ?? null);
const hasDatahub = computed(() => !!active.value?.apps.some((a) => a.id === "datahub" || a.id === "app"));

async function loadRights(organizationId: string) {
  const has = (action: string) =>
    authClient.organization
      .hasPermission({ organizationId, permissions: { connector: [action] } } as never)
      .then((r) => !!r.data?.success);
  const [create, update, remove] = await Promise.all([has("create"), has("update"), has("delete")]);

  rights.value = { create, update, delete: remove };
}

onMounted(async () => {
  try {
    const ctx = await load();

    if (!ctx.active?.canManageConnectors) return navigateTo("/", { replace: true });
    await loadRights(ctx.active.id);
  } catch (e) {
    error.value = errorMessage(e);
  }
});
</script>

<template>
  <div class="space-y-6">
    <FormAlert
      v-if="error"
      :message="error"
    />

    <PageLoader v-else-if="!active || !rights" />

    <template v-else>
      <PageHeader
        title="Appareils"
        :description="`Les appareils qui travaillent pour ${active.name} : connecteurs d'import vers le Data hub et postes d'impression d'AGO.`"
      >
        <template
          v-if="rights.create && hasDatahub"
          #actions
        >
          <Button as-child>
            <NuxtLink to="/connectors/pair">
              <Cable />
              Appairer un appareil
            </NuxtLink>
          </Button>
        </template>
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle>Comment appairer un nouvel appareil ?</CardTitle>

          <CardDescription>
            Un appareil s'identifie lui-même, sans mot de passe ni secret à copier. Un connecteur d'import ne peut
            qu'importer des données dans le Data hub, un poste d'impression ne peut que générer et vérifier des
            codes-barres dans AGO, pour cette organisation uniquement.
          </CardDescription>
        </CardHeader>

        <CardContent>
          <ol class="text-muted-foreground list-decimal space-y-1.5 pl-5 text-sm">
            <li>Installez et lancez le connecteur d'import ou le poste d'impression sur une machine du site.</li>

            <li>Il affiche un code à 8 lettres, valable 10 minutes (par exemple BDFG-HJKL).</li>

            <li>
              Ouvrez la page
              <NuxtLink
                to="/connectors/pair"
                class="text-foreground font-medium underline underline-offset-4"
              >
                Appairer un appareil
              </NuxtLink>
              , saisissez ce code, choisissez l'organisation et validez.
            </li>

            <li>
              L'appareil récupère son identifiant et commence à travailler. Vous pouvez le révoquer à tout moment.
            </li>
          </ol>

          <p
            v-if="!hasDatahub"
            class="mt-4 text-sm"
          >
            Cette organisation n'a ni le Data hub ni AGO : aucun appareil ne peut y être appairé.
          </p>

          <p class="text-muted-foreground mt-4 text-xs">
            La dernière connexion correspond au dernier jeton obtenu par l'appareil, juste avant son travail.
          </p>
        </CardContent>
      </Card>

      <OrgConnectorsTable
        endpoint="/api/account/organization/connectors"
        :can-rename="rights.update"
        :can-revoke="rights.delete"
      />
    </template>
  </div>
</template>
