export type SocialMetricScale = 'subtle' | 'daily' | 'rising' | 'popular' | 'viral'
export type SocialMetricProfile = 'resonance' | 'question' | 'informative' | 'controversy' | 'news'

export const SOCIAL_METRIC_SCALES = [
  { value: 'subtle', label: '克制', views: [200, 999], description: '200–999 曝光' },
  { value: 'daily', label: '日常', views: [1_000, 4_999], description: '1千–5千曝光' },
  { value: 'rising', label: '起量', views: [5_000, 19_999], description: '5千–2万曝光' },
  { value: 'popular', label: '热门', views: [20_000, 99_999], description: '2万–10万曝光' },
  { value: 'viral', label: '出圈', views: [100_000, 1_500_000], description: '10万–150万曝光' },
] as const

// Content changes the cost of each interaction; these are creative presets,
// calibrated to the supplied brief rather than measurements from X.
export const SOCIAL_METRIC_PROFILES = [
  { value: 'resonance', label: '金句 / 共鸣', likes: 1.25, replies: 0.7, reposts: 0.6, replyLimit: 0.08, repostLimit: 0.025 },
  { value: 'question', label: '提问 / 求助', likes: 0.9, replies: 2.4, reposts: 0.45, replyLimit: 0.1, repostLimit: 0.025 },
  { value: 'informative', label: '干货 / 方法', likes: 1, replies: 0.9, reposts: 2.8, replyLimit: 0.08, repostLimit: 0.07 },
  { value: 'controversy', label: '争议 / 讨论', likes: 0.85, replies: 3.4, reposts: 1.4, replyLimit: 0.1, repostLimit: 0.07 },
  { value: 'news', label: '新闻 / 立场', likes: 0.95, replies: 1.7, reposts: 1.6, replyLimit: 0.1, repostLimit: 0.07 },
] as const

export function normalizeSocialMetricScale(value: unknown): SocialMetricScale {
  return SOCIAL_METRIC_SCALES.find((scale) => scale.value === value)?.value ?? 'daily'
}

export function normalizeSocialMetricProfile(value: unknown): SocialMetricProfile {
  return SOCIAL_METRIC_PROFILES.find((profile) => profile.value === value)?.value ?? 'resonance'
}

export interface SocialMetrics {
  views: number
  likes: number
  replies: number
  reposts: number
}

// Poisson sampling reflects sparse, discrete interactions; unbiased rounding
// keeps large counts irregular without a loop proportional to their size.
function sampleCount(expected: number, random: () => number) {
  if (expected < 20) {
    const threshold = Math.exp(-expected)
    let count = 0
    let probability = 1
    do {
      count++
      probability *= random()
    } while (probability > threshold)
    return count - 1
  }
  const whole = Math.floor(expected)
  return whole + (random() < expected - whole ? 1 : 0)
}

export function generateSocialMetricsForViews(
  views: number,
  profile: SocialMetricProfile = 'resonance',
  random: () => number = Math.random,
): SocialMetrics {
  const content = SOCIAL_METRIC_PROFILES.find((option) => option.value === profile) ?? SOCIAL_METRIC_PROFILES[0]
  const reach = Math.max(views, 1_000) / 1_000
  // A shared response strength links all three counts, while the different
  // exponents dilute each rate as the audience spreads beyond core followers.
  const response = 0.55 + random()
  // Ordinary reach starts at 1–4% likes, 0.05–0.3% replies, and
  // 0.02–0.15% reposts. Content shapes stay within these shared ceilings;
  // wider reach dilutes them, with no occasional high-like multiplier.
  const likeDilution = Math.max(1, views / 5_000) ** -0.2
  const likeFloor = 0.01 * likeDilution
  const likeCeiling = 0.04 * likeDilution
  const likeRate = Math.min(likeCeiling, Math.max(likeFloor, 0.016 * content.likes * response * likeDilution))
  const likes = Math.max(Math.ceil(views * likeFloor), Math.min(Math.floor(views * likeCeiling), sampleCount(views * likeRate, random)))
  const replyExpected = views * 0.0008 * reach ** -0.25 * content.replies * response * (0.5 + random())
  const repostExpected = views * 0.00035 * reach ** -0.22 * content.reposts * response * (0.5 + random())

  // Small personal accounts cannot acquire a large discussion merely because
  // their selected content type is controversial or useful.
  const replyPoolLimit = Math.ceil(views * 0.003 * reach ** -0.25)
  const repostPoolLimit = views < 1_000 ? 1 : Math.ceil(views * 0.0015 * reach ** -0.22)
  const replyMax = Math.min(replyPoolLimit, likes - 1, Math.ceil(likes * content.replyLimit))
  const repostMax = Math.min(repostPoolLimit, likes - 1, Math.ceil(likes * content.repostLimit))
  // At broad reach, even quiet content should not pair thousands of likes
  // with only single-digit discussion and sharing.
  const replyMin = views >= 100_000 ? Math.ceil(likes * 0.01) : 0
  const repostMin = views >= 100_000 ? Math.ceil(likes * 0.004) : 0
  const replies = Math.min(replyMax, Math.max(replyMin, sampleCount(replyExpected, random)))
  const reposts = Math.min(repostMax, Math.max(repostMin, sampleCount(repostExpected, random)))
  // The expected sharing rate is lower for ordinary discussion shapes, while
  // discrete low counts may naturally include zero replies and one repost.

  return { views, likes, replies, reposts }
}

export function generateSocialMetrics(
  scale: SocialMetricScale = 'daily',
  profile?: SocialMetricProfile,
  random: () => number = Math.random,
): SocialMetrics {
  // Most ordinary posts earn nods rather than discussion or sharing. Choose
  // one coherent content shape per click, with uncommon debate/news shapes.
  const shape = random()
  const selectedProfile = profile ?? (shape < 0.6 ? 'resonance' : shape < 0.75 ? 'question' : shape < 0.9 ? 'informative' : shape < 0.94 ? 'controversy' : 'news')
  const band = SOCIAL_METRIC_SCALES.find((option) => option.value === scale) ?? SOCIAL_METRIC_SCALES[1]
  const [min, max] = band.views
  // Log sampling gives the lower end of each exposure band room to appear.
  const views = Math.min(max, Math.floor(min * ((max + 1) / min) ** random()))
  return generateSocialMetricsForViews(views, selectedProfile, random)
}

export function compactSocialMetric(value: number): string {
  if (value < 1_000) return String(value)
  // Truncate, so 999.9K never rounds up into the next exposure band. Keep a
  // decimal at every size instead of turning 12.7K into a tidy 13K.
  const divisor = value < 1_000_000 ? 1_000 : 1_000_000
  return `${Math.floor(value / divisor * 10) / 10}${divisor === 1_000 ? 'K' : 'M'}`
}
