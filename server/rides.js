import db, { getSetting, setSetting, tx } from './db.js'

// 设施经营操作模块：升级等涉及资产与现金的多步写入统一在事务内完成
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }

export const UPGRADE_COST_PER_POINT = 3000
export const MAX_RIDE_LEVEL = 100

const ctx = {
  day: () => num(getSetting('day'), 1),
  tick: () => num(getSetting('tick'), 0),
  cash: () => num(getSetting('cash'), 0),
  logFinance: null
}
export function initRideContext(deps = {}) {
  Object.assign(ctx, deps)
}

function parseUpgrade(raw) {
  // 拒绝布尔值、空值、非数字、小数、0 和负数；数字字符串由 Number 规范化后再校验
  if (typeof raw !== 'number' && typeof raw !== 'string') return { error: '升级值必须是大于 0 的整数' }
  if (typeof raw === 'string' && !raw.trim()) return { error: '升级值必须是大于 0 的整数' }
  const value = Number(raw)
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return { error: '升级值必须是大于 0 的整数' }
  }
  if (value > MAX_RIDE_LEVEL) return { error: `单次升级值不能超过 ${MAX_RIDE_LEVEL}` }
  return { value }
}

// 升级设施：属性提升、现金扣减、财务流水必须同一事务原子提交
export function upgradeRide(rideId, rawUpgrade) {
  const parsed = parseUpgrade(rawUpgrade)
  if (parsed.error) return { ok: false, msg: parsed.error }
  const upgrade = parsed.value

  return tx(() => {
    const ride = db.prepare('SELECT * FROM rides WHERE id=?').get(rideId)
    if (!ride) return { ok: false, msg: '设施不存在' }

    const thrillAfter = ride.thrill + upgrade
    if (thrillAfter > MAX_RIDE_LEVEL) {
      return { ok: false, msg: `升级后刺激度不能超过 ${MAX_RIDE_LEVEL}` }
    }

    const cost = upgrade * UPGRADE_COST_PER_POINT
    const cashBefore = Math.round(ctx.cash())
    if (cashBefore < cost) return { ok: false, msg: '资金不足，本次升级未生效' }

    const attrAfter = Math.min(
      MAX_RIDE_LEVEL,
      Math.round((ride.attr + upgrade * 0.3) * 10) / 10
    )

    db.prepare('UPDATE rides SET thrill=?, attr=? WHERE id=?')
      .run(thrillAfter, attrAfter, ride.id)
    setSetting('cash', cashBefore - cost)
    ctx.logFinance?.(
      ctx.day(),
      '升级',
      -cost,
      `升级设施「${ride.name}」刺激度 +${upgrade}`
    )

    return {
      ok: true,
      cost,
      thrill: thrillAfter,
      attr: attrAfter,
      cash: cashBefore - cost
    }
  })
}
