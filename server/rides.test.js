// 设施升级原子性测试：
// 升级值校验 + 属性提升 + 现金扣减 + 财务流水必须同一事务提交；
// 非法值或流水写入失败时，设施属性与现金均不得发生变化。
// 运行：node --test server/rides.test.js（需 Node >= 22.5，node:sqlite）
process.env.PARK_DB_PATH = ':memory:'

import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const { default: db, getSetting, setSetting } = await import('./db.js')
const RIDES = await import('./rides.js')

const finLogs = []
let failFinance = false
RIDES.initRideContext({
  logFinance: (day, label, amount, detail) => {
    if (failFinance) throw new Error('模拟升级财务流水写入失败')
    finLogs.push({ day, label, amount, detail })
  }
})

const cash = () => Number(getSetting('cash'))
const rideById = id => db.prepare('SELECT * FROM rides WHERE id=?').get(id)
const financeCount = () => db.prepare('SELECT COUNT(*) n FROM finance').get().n

before(() => {
  setSetting('day', 1)
  setSetting('tick', 0)
  setSetting('cash', 200000)
})

test('合法升级：刺激度/吸引度、现金扣减和财务流水原子生效', () => {
  const before = rideById(2)
  const cash0 = cash()
  const fin0 = financeCount()

  const r = RIDES.upgradeRide(2, 10)
  assert.equal(r.ok, true)
  assert.equal(r.cost, 30000)
  assert.equal(r.thrill, before.thrill + 10)
  assert.equal(r.attr, Math.min(100, Math.round((before.attr + 3) * 10) / 10))
  assert.equal(cash(), cash0 - 30000)

  const after = rideById(2)
  assert.equal(after.thrill, before.thrill + 10)
  assert.equal(after.attr, Math.min(100, Math.round((before.attr + 3) * 10) / 10))
  assert.equal(financeCount(), fin0 + 1)
  assert.deepEqual(finLogs.at(-1), {
    day: 1, label: '升级', amount: -30000,
    detail: `升级设施「${before.name}」刺激度 +10`
  })
})

test('负数升级被拒绝，不能反向降低刺激度并增加现金', () => {
  const before = rideById(1)
  const cash0 = cash()
  const fin0 = financeCount()

  const r = RIDES.upgradeRide(1, -10)
  assert.equal(r.ok, false)
  assert.equal(r.msg, '升级值必须是大于 0 的整数')

  const after = rideById(1)
  assert.equal(after.thrill, before.thrill)
  assert.equal(after.attr, before.attr)
  assert.equal(cash(), cash0)
  assert.equal(financeCount(), fin0)
})

test('零、非数字、小数和布尔值均不能作为升级值', () => {
  for (const bad of [0, '0', '-5', '', '   ', 'abc', 1.5, true, false, null]) {
    const before = rideById(1)
    const cash0 = cash()
    const r = RIDES.upgradeRide(1, bad)
    assert.equal(r.ok, false, `非法升级值 ${String(bad)} 应被拒绝`)
    assert.equal(rideById(1).thrill, before.thrill)
    assert.equal(rideById(1).attr, before.attr)
    assert.equal(cash(), cash0)
  }
})

test('刺激度升级后不得超过 100，且不扣款不产生流水', () => {
  const before = rideById(1)
  const cash0 = cash()
  const fin0 = financeCount()

  const r = RIDES.upgradeRide(1, 20)
  assert.equal(r.ok, false)
  assert.equal(r.msg, '升级后刺激度不能超过 100')

  const after = rideById(1)
  assert.equal(after.thrill, before.thrill)
  assert.equal(after.attr, before.attr)
  assert.equal(cash(), cash0)
  assert.equal(financeCount(), fin0)
})

test('吸引度最高提升至 100，但仍按完整刺激度升级扣款', () => {
  db.prepare('UPDATE rides SET thrill=95, attr=99.5 WHERE id=3').run()
  const cash0 = cash()

  const r = RIDES.upgradeRide(3, 5)
  assert.equal(r.ok, true)
  assert.equal(r.thrill, 100)
  assert.equal(r.attr, 100)
  assert.equal(r.cost, 15000)
  assert.equal(cash(), cash0 - 15000)
})

test('资金不足时整体拒绝，不产生任何升级副作用', () => {
  setSetting('cash', 1000)
  const before = rideById(4)
  const cash0 = cash()
  const fin0 = financeCount()

  const r = RIDES.upgradeRide(4, 1)
  assert.equal(r.ok, false)
  assert.equal(r.msg, '资金不足，本次升级未生效')

  const after = rideById(4)
  assert.equal(after.thrill, before.thrill)
  assert.equal(after.attr, before.attr)
  assert.equal(cash(), cash0)
  assert.equal(financeCount(), fin0)
  setSetting('cash', 200000)
})

test('财务流水写入失败时，设施升级和扣款整体回滚', () => {
  const before = rideById(5)
  const cash0 = cash()
  const fin0 = financeCount()

  failFinance = true
  assert.throws(() => RIDES.upgradeRide(5, 2), /模拟升级财务流水写入失败/)
  failFinance = false

  const after = rideById(5)
  assert.equal(after.thrill, before.thrill, '刺激度应回滚')
  assert.equal(after.attr, before.attr, '吸引度应回滚')
  assert.equal(cash(), cash0, '现金应回滚')
  assert.equal(financeCount(), fin0, '不得留下财务流水')
})
