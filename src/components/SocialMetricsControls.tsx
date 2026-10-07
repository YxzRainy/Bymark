import { Dices } from 'lucide-vue-next'
import { computed, defineComponent } from 'vue'
import type { BymarkState } from '../bymark'
import {
  compactSocialMetric,
  generateSocialMetrics,
  SOCIAL_METRIC_SCALES,
  type SocialMetricScale,
} from '../socialMetrics'
import { SettingsDisclosure } from './SettingsDisclosure'

const metricFields = [
  ['socialReplies', '评论', 'replies'],
  ['socialReposts', '转发', 'reposts'],
  ['socialLikes', '喜欢', 'likes'],
  ['socialViews', '浏览', 'views'],
] as const
type MetricKey = typeof metricFields[number][0] | 'socialMetricScale'

export const SocialMetricsControls = defineComponent((props: {
  state: Pick<BymarkState, MetricKey>
  update: <K extends MetricKey>(key: K, value: BymarkState[K]) => void
}) => {
  const selectedScale = computed(() => SOCIAL_METRIC_SCALES.find((scale) => scale.value === props.state.socialMetricScale) ?? SOCIAL_METRIC_SCALES[1])
  const randomize = (scale: SocialMetricScale = props.state.socialMetricScale) => {
    const metrics = generateSocialMetrics(scale)
    for (const [key, , metric] of metricFields) props.update(key, compactSocialMetric(metrics[metric]))
  }
  const selectScale = (scale: SocialMetricScale) => {
    props.update('socialMetricScale', scale)
    randomize(scale)
  }

  return () => (
    <SettingsDisclosure
      id="bymark-social-metrics"
      label="互动数据"
      class="social-metrics-disclosure"
      v-slots={{
        action: () => (
          <button
            type="button"
            class="social-metrics-random-button"
            aria-label={`按${selectedScale.value.label}规模随机生成四项互动数据`}
            title={`按${selectedScale.value.label}规模随机生成四项互动数据`}
            onClick={() => randomize()}
          >
            <Dices size={16} aria-hidden="true" />
          </button>
        ),
      }}
    >
      <section class="social-metrics-editor" aria-label="互动数据编辑">
        <div class="social-metrics-scale">
          <span>曝光档位</span>
          <div class="social-metrics-scale-picker" role="group" aria-label="随机互动数据规模">
            {SOCIAL_METRIC_SCALES.map((option) => (
              <button
                key={option.value}
                type="button"
                class={props.state.socialMetricScale === option.value ? 'active' : ''}
                aria-pressed={props.state.socialMetricScale === option.value}
                title={option.description}
                onClick={() => selectScale(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div class="social-metrics-grid">
          {metricFields.map(([key, label]) => (
            <label key={key} class="social-metric-field" for={`bymark-${key}`}>
              <span>{label}</span>
              <input
                id={`bymark-${key}`}
                class="control"
                value={props.state[key]}
                maxlength={8}
                inputmode="text"
                placeholder="留空"
                onInput={(event: Event) => props.update(key, (event.target as HTMLInputElement).value)}
              />
            </label>
          ))}
        </div>
      </section>
    </SettingsDisclosure>
  )
}, { props: ['state', 'update'] })
