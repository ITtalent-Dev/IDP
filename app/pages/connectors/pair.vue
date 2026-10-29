<script setup lang="ts">
import { CircleCheck } from "lucide-vue-next";
import { errorMessage } from "~/lib/errors";
import { CONNECTOR_KIND_LABELS } from "~/lib/labels";
import type { PairingOrganization } from "~/lib/org";

definePageMeta({ layout: "auth", middleware: "auth" });
useHead({ title: "Appairer un appareil" });

interface PairingPreview {
  userCode: string;
  name: string | null;
  kind: string;
  app: string;
  expiresAt: string;
}

const route = useRoute();
const code = ref(typeof route.query.code === "string" ? route.query.code : "");
const organizationId = ref("");
const name = ref("");
const organizations = ref<PairingOrganization[] | null>(null);
const preview = ref<PairingPreview | null>(null);
const error = ref("");
const busy = ref(false);
const outcome = ref<"approved" | "denied" | null>(null);

const normalizedCode = computed(() => code.value.toUpperCase().replace(/[^A-Z]/g, ""));
const kindLabels = computed(() => (preview.value ? CONNECTOR_KIND_LABELS[preview.value.kind] : undefined));
const eligibleOrganizations = computed(() =>
  (organizations.value ?? []).filter((o) => !preview.value || o.apps.includes(preview.value.app)),
);
const organizationOptions = computed(() => eligibleOrganizations.value.map((o) => ({ value: o.id, label: o.name })));
const organizationName = computed(() => organizations.value?.find((o) => o.id === organizationId.value)?.name ?? "");
const ready = computed(() => normalizedCode.value.length === 8 && !!organizationId.value && !!name.value.trim());

const fail = (e: unknown) => {
  error.value = errorMessage((e as { data?: unknown }).data ?? e);
};

async function lookup() {
  preview.value = null;
  if (normalizedCode.value.length !== 8) return;
  try {
    const res = await $fetch<{ pairing: PairingPreview }>("/api/account/connectors/pairing", {
      query: { code: normalizedCode.value },
    });

    preview.value = res.pairing;
    if (!eligibleOrganizations.value.some((o) => o.id === organizationId.value)) {
      organizationId.value = eligibleOrganizations.value.length === 1 ? eligibleOrganizations.value[0]!.id : "";
    }

    if (!name.value && res.pairing.name) name.value = res.pairing.name;
    error.value = "";
  } catch (e) {
    fail(e);
  }
}

watch(normalizedCode, (value, previous) => {
  if (value.length === 8 && value !== previous) lookup();
});

async function decide(decision: "approve" | "deny") {
  busy.value = true;
  error.value = "";
  try {
    await $fetch(`/api/account/connectors/pairing/${decision}`, {
      method: "POST",
      body: {
        userCode: normalizedCode.value,
        organizationId: organizationId.value,
        ...(decision === "approve" ? { name: name.value.trim() } : {}),
      },
    });
    outcome.value = decision === "approve" ? "approved" : "denied";
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  try {
    const res = await $fetch<{ organizations: PairingOrganization[] }>("/api/account/connectors/organizations");

    organizations.value = res.organizations;
    if (res.organizations.length === 1) organizationId.value = res.organizations[0]!.id;
    if (normalizedCode.value.length === 8) await lookup();
  } catch (e) {
    fail(e);
  }
});
</script>

<template>
  <AuthCard
    title="Appairer un appareil"
    description="Saisissez le code affiché par l'appareil (connecteur d'import ou poste d'impression) pour l'autoriser."
  >
    <PageLoader v-if="!organizations && !error" />

    <div
      v-else-if="outcome"
      class="space-y-4 text-center"
    >
      <CircleCheck class="mx-auto size-10 text-emerald-600" />

      <p class="text-sm">
        {{
          outcome === "approved"
            ? `L'appareil « ${name.trim()} » est appairé à ${organizationName}. Il va récupérer son identifiant d'elle-même dans quelques secondes.`
            : "L'appairage a été refusé. L'appareil ne recevra aucun accès."
        }}
      </p>

      <Button
        as-child
        variant="outline"
      >
        <NuxtLink to="/">Retour au tableau de bord</NuxtLink>
      </Button>
    </div>

    <template v-else>
      <FormAlert :message="error" />

      <p
        v-if="organizations && !organizations.length"
        class="text-muted-foreground text-sm"
      >
        Aucune de vos organisations ne vous permet d'appairer un appareil : il faut la permission « Appareils : Créer /
        appairer ». Demandez-la à un gérant.
      </p>

      <form
        v-else-if="organizations"
        class="grid gap-5"
        @submit.prevent="decide('approve')"
      >
        <FormField
          v-model="code"
          label="Code de l'appareil"
          placeholder="XXXX-XXXX"
          autocomplete="off"
          hint="Le code est valable 10 minutes."
          required
        />

        <p
          v-if="preview"
          class="text-muted-foreground -mt-3 text-xs"
        >
          Code reconnu : {{ (kindLabels?.label ?? "appareil").toLowerCase()
          }}{{ preview.name ? ` « ${preview.name} »` : "" }}.
        </p>

        <div class="grid gap-2">
          <Label for="pair-organization">Organisation</Label>

          <AppSelect
            id="pair-organization"
            v-model="organizationId"
            :options="organizationOptions"
            placeholder="Choisir une organisation"
          />
        </div>

        <FormField
          v-model="name"
          label="Nom de l'appareil"
          placeholder="Ex. : Serveur de l'agence de Lyon"
          hint="Pour reconnaître l'appareil dans la liste des appareils de l'organisation."
          required
        />

        <div class="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            :disabled="busy || normalizedCode.length !== 8 || !organizationId"
            @click="decide('deny')"
          >
            Refuser
          </Button>

          <Button
            type="submit"
            :disabled="busy || !ready"
          >
            Autoriser l'appareil
          </Button>
        </div>

        <p
          v-if="preview && !eligibleOrganizations.length"
          class="text-sm"
        >
          Aucune de vos organisations n'a l'application de cet appareil : il ne peut pas être appairée.
        </p>

        <p class="text-muted-foreground text-xs">
          L'appareil pourra uniquement {{ kindLabels?.capability ?? "faire ce que permet son type" }}, pour
          l'organisation choisie. Aucun secret n'est affiché ni à recopier.
        </p>
      </form>
    </template>
  </AuthCard>
</template>
