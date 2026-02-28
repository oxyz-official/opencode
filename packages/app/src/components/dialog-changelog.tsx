import { createSignal, onMount, Show } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { fetchReleases, type Release } from "@/api/releases"
import { ReleaseList } from "@/components/release-list"

export function DialogChangelog() {
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()
  const [releases, setReleases] = createSignal<Release[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | undefined>(undefined)

  async function loadReleases() {
    const result = await fetchReleases(platform, language.t)
      .then((r) => ({ releases: r.releases, error: undefined }))
      .catch((e) => ({ releases: [], error: e instanceof Error ? e.message : "Failed to load changelog" }))

    setReleases(result.releases)
    setError(result.error)
    setLoading(false)
  }

  onMount(() => loadReleases())

  return (
    <Dialog size="x-large" transition title="Changelog">
      <div class="flex-1 min-h-0 flex flex-col">
        <Show when={loading()}>
          <p class="text-text-weak p-6">{language.t("common.loading")}...</p>
        </Show>
        <Show when={error()}>
          <p class="text-text-weak p-6">{error()}</p>
        </Show>
        <Show when={!loading() && !error() && releases().length === 0}>
          <p class="text-text-weak p-6">{language.t("common.noReleasesFound")}</p>
        </Show>
        <Show when={!loading() && !error() && releases().length > 0}>
          <ReleaseList releases={releases()} hasMore={false} loadingMore={false} onLoadMore={() => {}} />
        </Show>
      </div>
    </Dialog>
  )
}
