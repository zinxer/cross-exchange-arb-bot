require("dotenv").config();
const BigNumber = require('bignumber.js')
const ccxtClient = require('./bin/initExchangeClient')
const fs = require('fs-extra')
const { systemLog } = require('./bin/term_log')
const { cancelLimitPlaceMarket, placeLimitOrder } = require('./controllers/core')
const { getExternalIpAddress, currTime, sleep, usdToMyr } = require('./bin/utils')
const axios = require('axios')
const si = require('systeminformation');
const util = require('util');
const { buda } = require("ccxt");

process.env.APP_ROOT = __dirname
process.env.BOT_VER = 'v2.4.1'

let TICKER = {}
let ORDERS = {}

let ASSETS = process.env.ASSETS.split(',');
const masterBase = 'MYR'
const slaveBase = 'USDT'
let MASTER_ORDER_ID = null

const DECIMALS = {
    //TODO:
    BTC: 4, //FTX max decimal places is 4
    BCH: 3, //FTX + Binance max decimal places is 3
    ETH: 3, //FTX max decimal places is 3
    XRP: 0, //FTX + Binance max decimal places is 0
    LTC: 2, //FTX max decimal places is 2
}

async function init() {
    try {
        if (process.env.SAFE_GAP_PERCENT < parseFloat(process.env.MIN_SAFE_GAP_PERCENT || '0.2')) {
            systemLog("error", `SAFE_GAP_PERCENT (${process.env.SAFE_GAP_PERCENT}) should not be less than ${process.env.MIN_SAFE_GAP_PERCENT || '0.2'}.`)
            process.exit(0)
        }
        process.env.SI_DATA = JSON.stringify((await si.system()))
        const SI_DATA = JSON.parse(process.env.SI_DATA)
        let ipAddress = await getExternalIpAddress()
        process.env.IP_ADDRESS = ipAddress

        systemLog("info", `Initializing cross-exchange-arb-bot (${process.env.BOT_VER})...`)
        systemLog("system", `cross-exchange-arb-bot (${process.env.BOT_VER}) started`)

        initTicker()
        run()
    } catch (error) {
        throw error
    }
}

async function initTicker() {
    let _assets = [...ASSETS, masterBase, slaveBase]
    for (let asset of _assets) {
        TICKER[asset] = {}
        for (let exchange in ccxtClient) {
            let prop = { balance: undefined }
            if ((asset !== masterBase) && (asset !== slaveBase)) {
                prop['ask'] = undefined
                prop['bid'] = undefined
                prop['last'] = undefined

                if (exchange == 'luno') { prop['master'] = { buy: { bestPremiumPercent: undefined, slave: undefined }, sell: { bestPremiumPercent: undefined, slave: undefined } } }
            }

            TICKER[asset][exchange] = prop
        }
    }
}


function updateBalanceFile() {

    //clear file first
    fs.writeFile('./balances.txt', '')
    let tickerObj = TICKER

    for (let asset in tickerObj) {
        if (asset == 'MYR') { delete tickerObj[asset]['FTX']; continue }
        if (asset == "USDT") { delete tickerObj[asset]['luno']; continue }
        //delete tickerObj[asset]['luno'].master
    }
    fs.writeFile('./balances.txt', JSON.stringify(tickerObj, null, 4))
}

function recordTrade(message) {
    // logging trade to file
    message = `${currTime()},${message}`
    fs.appendFileSync('./trade_data.csv', `${message}${os.EOL}`)
}

async function fetchUsdtMyrRate() {
    try {
        let rate = process.env.USDTMYR || null
        if (!rate) {
            let queryData = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=myr`)
            process.env.USDTMYR = queryData.data['tether'].myr || 4.
            if (!queryData.data['tether'].myr) {
                systemLog("warning", `USDTMYR not set in .env and coingecko fetch usdtmyr rate failed. Default to 4.15`)
            }
        }

        return rate
    } catch (error) {
        throw error
    }

}

async function fetchTicker() {
    try {
        //console.time('fetchTicker')
        let promises = []

        for (let exClient in ccxtClient) {
            exClient = ccxtClient[exClient]
            let fetchTickerPromise = new Promise(async function (resolve, reject) {
                let base = slaveBase
                if (exClient.name == "luno") { base = masterBase }
                let symbols = []

                for (let asset of ASSETS) { symbols.push(`${asset}/${base}`) }
                let symbolData = await exClient.fetchTickers(symbols)

                for (let asset of ASSETS) {
                    let { bid, ask, last } = symbolData[`${asset}/${base}`]
                    TICKER[asset][exClient.name].bid = bid
                    TICKER[asset][exClient.name].ask = ask
                    TICKER[asset][exClient.name].last = last
                }
                resolve("OK")
            })
            promises.push(fetchTickerPromise)
        }

        await Promise.all(promises)
        //console.timeEnd('fetchTicker')
        process.env.TICKER = JSON.stringify(TICKER)
    } catch (error) {
        throw error
    }
}

async function fetchBalances() {
    try {
        for (let exClient in ccxtClient) {
            exClient = ccxtClient[exClient]
            let balances = await exClient.fetchBalance()
            for (let asset of ASSETS) {
                TICKER[asset][exClient.name]['balance'] = balances.free[asset] ? balances.free[asset] : 0
            }
            if (exClient.name == "luno") {
                TICKER[masterBase][exClient.name]['balance'] = balances.free[masterBase]
            } else {
                TICKER[slaveBase][exClient.name]['balance'] = balances.free[slaveBase]
            }
        }

        await updateBalanceFile()
    } catch (error) {
        throw error
    }
}

async function isBalSufficient(exchange, asset) {
    try {
        let orderSizeMyr = process.env.ORDER_SIZE_MYR

        if (asset == 'USDT' || asset == 'USD') {
            if (exchange == 'luno') { throw new Error("Luno does not have USDT balance.") }
            if (orderSizeMyr > usdToMyr(TICKER[asset][exchange].balance)) { return false } else { return true }
        }

        if (asset == 'MYR') {
            if (exchange !== 'luno') { throw new Error("Other exchanges does not have MYR balance.") }
            if (orderSizeMyr > TICKER[asset][exchange].balance) { return false } else { return true }
        }

        let balance = TICKER[asset][exchange].balance
        let balanceInLocalCurrency = (new BigNumber(TICKER[asset][exchange].last).multipliedBy(balance).toFixed(2))

        if (exchange !== 'luno') {
            balanceUsd = usdToMyr(balanceInLocalCurrency)
            if (orderSizeMyr > balanceUsd) { return false } else { return true }
        } else {
            if (orderSizeMyr > balanceInLocalCurrency) { return false } else { return true }
        }
    } catch (error) {
        throw error
    }
}

// compute all best price gap by asset and side
async function computeBestPremiumPercent() {
    try {
        for (let asset of ASSETS) {
            let lunoLast = TICKER[asset]['luno'].last

            for (let exchange in ccxtClient) {
                if (exchange == 'luno') { continue }
                else {
                    let slaveLastMyr = usdToMyr(TICKER[asset][exchange].last)
                    let minusBN = new BigNumber(lunoLast).minus(new BigNumber(slaveLastMyr))
                    let gapPercent = (((minusBN).dividedBy(new BigNumber(lunoLast))).multipliedBy(new BigNumber(100))).toFixed()

                    // to determine master sell bestPremiumPercent
                    // Check if there is sufficient asset balance on Luno and usdt balance on slave
                    if (!isBalSufficient('luno', asset) || !isBalSufficient(exchange, slaveBase)) { continue }
                    let bestPremiumPercentSell = TICKER[asset]['luno']['master']['sell'].bestPremiumPercent
                    if (bestPremiumPercentSell == undefined) {
                        TICKER[asset]['luno']['master']['sell'].bestPremiumPercent = gapPercent
                        TICKER[asset]['luno']['master']['sell'].slave = exchange
                    }
                    if (gapPercent > bestPremiumPercentSell) {
                        TICKER[asset]['luno']['master']['sell'].bestPremiumPercent = gapPercent
                        TICKER[asset]['luno']['master']['sell'].slave = exchange
                    }

                    gapPercent = new BigNumber(gapPercent).multipliedBy(-1).toFixed()
                    // to determine master buy bestPremiumPercent
                    // Check if there is sufficient asset balance on Luno and usdt balance on slave
                    if (!isBalSufficient('luno', masterBase) || !isBalSufficient(exchange, asset)) { continue }
                    let bestPremiumPercentBuy = TICKER[asset]['luno']['master']['buy'].bestPremiumPercent
                    if (bestPremiumPercentBuy == undefined) {
                        TICKER[asset]['luno']['master']['buy'].bestPremiumPercent = gapPercent
                        TICKER[asset]['luno']['master']['buy'].slave = exchange
                    }
                    if (gapPercent > bestPremiumPercentBuy) {
                        TICKER[asset]['luno']['master']['buy'].bestPremiumPercent = gapPercent
                        TICKER[asset]['luno']['master']['buy'].slave = exchange
                    }
                }
            }
        }
    } catch (error) {
        throw error
    }
}

async function computePotentialOrderSequence() {
    try {
        let masterBestBuy = undefined
        let masterBestSell = undefined
        for (let asset of ASSETS) {
            let bestBuyPercent = TICKER[asset]['luno']['master']['buy'].bestPremiumPercent
            let bestSellPercent = TICKER[asset]['luno']['master']['sell'].bestPremiumPercent

            if (bestBuyPercent !== undefined) {
                if (masterBestBuy == undefined) {
                    masterBestBuy = TICKER[asset]['luno']['master']['buy']
                    masterBestBuy['asset'] = asset
                } else if (Number(bestBuyPercent) > Number(masterBestBuy.bestPremiumPercent)) {
                    masterBestBuy = TICKER[asset]['luno']['master']['buy']
                    masterBestBuy['asset'] = asset
                }
            }

            if (bestSellPercent !== undefined) {
                if (masterBestSell == undefined) {
                    masterBestSell = TICKER[asset]['luno']['master']['sell']
                    masterBestSell['asset'] = asset
                } else if (Number(bestBuyPercent) > Number(masterBestBuy.bestPremiumPercent)) {
                    masterBestSell = TICKER[asset]['luno']['master']['sell']
                    masterBestSell['asset'] = asset
                }
            }
        }
        if ((masterBestBuy == undefined) || (masterBestSell == undefined)) { return false }

        // Calculate premium
        let sumPremiums = new BigNumber(masterBestBuy.bestPremiumPercent).plus(new BigNumber(masterBestSell.bestPremiumPercent)).toFixed()

        ORDERS['luno'] = {
            buy: masterBestBuy.asset,
            sell: masterBestSell.asset
        }

        ORDERS[masterBestBuy.slave] = { sell: undefined }
        ORDERS[masterBestBuy.slave]['sell'] = masterBestBuy.asset

        if (ORDERS[masterBestSell.slave] == undefined) { ORDERS[masterBestSell.slave] = { buy: undefined } }
        ORDERS[masterBestSell.slave]['buy'] = masterBestSell.asset

        if (ORDERS['luno'].buy !== ORDERS['luno'].sell) {
            if (sumPremiums > 0) {
                let msg = `${JSON.stringify(ORDERS)} ${(parseFloat(sumPremiums)).toFixed(2)}%`
                systemLog('info', msg)
            } else { systemLog('info', 'No profitable pairs.') }

            //TODO: uncommented below line due to development purpose.
            if (Number(sumPremiums) < process.env.SAFE_GAP_PERCENT) { ORDERS = {}; return false }

            // TODO: Remove the hardcorded ORDERS, used for development purposes only.
            //ORDERS = { "luno": { "buy": "ETH", "sell": "BTC" }, "FTX": { "sell": "ETH", "buy": "BTC" } }
        } else {
            systemLog('info', 'No profitable pairs.')
            ORDERS = {}
        }
    } catch (error) {
        throw error
    }
}

async function getAssetAmountFromFilledCost(masterFilledCostMyr, secondAssetPriceMyr, secondAsset) {
    try {
        let amount = (new BigNumber(masterFilledCostMyr).dividedBy(secondAssetPriceMyr)).toFixed(DECIMALS[secondAsset])
        return amount
    } catch (error) {
        throw error
    }
}

async function _createMarketOrder(exchange, symbol, side, amount) {
    try {
        if (amount == 0) {
            systemLog("warning", `Amount ${amount} to create market order for ${symbol} is too small.`)
            return
        }

        if (!exchange || !symbol || !side) { throw Error(`Missing input param to create market order. ${exchange},${symbol},${side},${amount}`) }

        // place market order
        //console.log(exchange, symbol, side, amount)
        let { id } = await ccxtClient[exchange].createOrder(symbol, 'market', side, amount)

        //wait for market order to be created and updated on exchange servers.
        await sleep(1000)

        let orderInfo = exchange !== 'Binance' ? await ccxtClient[exchange].fetchOrder(id) : await ccxtClient[exchange].fetchOrder(id, symbol)

        ORDERS[exchange][`${side}Cost`] = exchange == 'luno' ? orderInfo.cost : usdToMyr(orderInfo.cost)
        if (exchange == 'luno') { ORDERS[exchange][`${side}BaseFee`] = orderInfo.fee.cost }

    } catch (error) {
        throw error
    }
}

async function placeOrders() {
    try {
        // place master limit buy order first
        let masterBuyAsset = ORDERS['luno'].buy
        let masterBuyBidPrice = TICKER[masterBuyAsset]['luno'].bid
        let masterBuySymbol = `${ORDERS['luno'].buy}/${masterBase}`
        let percentBN = new BigNumber(0.0001).multipliedBy(new BigNumber(masterBuyBidPrice))
        let percentPlusPriceBN = percentBN.plus(new BigNumber(masterBuyBidPrice))
        let masterBuyAmount = (new BigNumber(process.env.ORDER_SIZE_MYR).dividedBy(percentPlusPriceBN)).toFixed(DECIMALS[masterBuyAsset])

        // skip placing order if already exist
        if (!MASTER_ORDER_ID) {
            //console.log(masterBuySymbol, masterBuyAmount, percentPlusPriceBN.toFixed(2))
            let { id } = await ccxtClient['luno'].createLimitBuyOrder(masterBuySymbol, masterBuyAmount, percentPlusPriceBN.toFixed(2))
            MASTER_ORDER_ID = id
            await sleep(process.env.CYCLE_TIME_MS)

            // ** cancel above limit order and get amount filled.
            let { status } = await ccxtClient['luno'].fetchOrder(id)
            if (status == "open") {
                // cancel order first
                await ccxtClient['luno'].cancelOrder(id)
                // allow exchange to update their own system before responding.
                await sleep(300)
            }
        }

        if (MASTER_ORDER_ID) { id = MASTER_ORDER_ID }
        // query to get filled amount and make sure order is closed
        let orderInfo = await ccxtClient['luno'].fetchOrder(id)
        if (orderInfo.filled > 0) {
            let filledAmt = Math.round((orderInfo.filled + Number.EPSILON) * (10 ** DECIMALS[masterBuyAsset])) / (10 ** DECIMALS[masterBuyAsset])
            let masterBaseFee = orderInfo.fee.cost

            ORDERS['luno']['buyCost'] = orderInfo.cost
            ORDERS['luno']['buyBaseFee'] = masterBaseFee

            let masterSellAsset = ORDERS['luno'].sell
            await _createMarketOrder('luno', `${masterSellAsset}/${masterBase}`, 'sell', await getAssetAmountFromFilledCost(orderInfo.cost, TICKER[masterSellAsset]['luno'].last, masterSellAsset))

            for (let exClient in ccxtClient) {
                if (exClient == 'luno') { continue }

                let slaveBuyAsset = ORDERS[exClient].buy
                let slaveAssetPriceMyr1 = usdToMyr(TICKER[slaveBuyAsset][exClient].last)
                await _createMarketOrder(exClient, `${slaveBuyAsset}/${slaveBase}`, 'buy', await getAssetAmountFromFilledCost(orderInfo.cost, slaveAssetPriceMyr1, slaveBuyAsset))

                let slaveSellAsset = ORDERS[exClient].sell
                let slaveAssetPriceMyr2 = usdToMyr(TICKER[slaveSellAsset][exClient].last)
                await _createMarketOrder(exClient, `${slaveSellAsset}/${slaveBase}`, 'sell', await getAssetAmountFromFilledCost(orderInfo.cost, slaveAssetPriceMyr2, slaveSellAsset))
            }
            let diff1 = Math.abs(Number(ORDERS['luno'].buyCost) - Number(ORDERS[Object.keys(ORDERS)[1]].sellCost))
            let diff2 = Math.abs(Number(ORDERS['luno'].sellCost) - Number(ORDERS[Object.keys(ORDERS)[1]].buyCost))

            let myrProfit = Math.abs(diff1 - diff2)
            let msg = `${ORDERS['luno'].buyCost},${ORDERS[Object.keys(ORDERS)[1]].sellCost},${ORDERS['luno'].sellCost},${ORDERS[Object.keys(ORDERS)[1]].buyCost},${parseFloat(myrProfit).toFixed(2)}`
            recordTrade(msg)
            systemLog("info", msg)
        }

    } catch (error) {
        let newError = Object.getOwnPropertyNames(error).reduce((acc, key) => { acc[key] = error[key]; return acc; }, {})
        if ((newError.message).match(/ErrCannotStopUnknownOrNonPendingOrder/g)) { await placeOrders() }
        else { throw error }
    }
}

async function run() {
    try {
        //console.time('run')
        if (process.env.ON_KILL) { systemLog("info", `Bot cycle stopped.`); process.exit() }

        // set USDTMYR in .env to reduce time used to call coingecko api
        await fetchUsdtMyrRate()
        // populate TICKER glob
        await fetchTicker()
        // fetch new balance because it may be reduced from previous iter placements
        await fetchBalances()
        await computeBestPremiumPercent()

        //console.log(util.inspect(TICKER, { showHidden: false, depth: null, colors: true }))
        await computePotentialOrderSequence()

        if (Object.keys(ORDERS).length !== 0) {
            await placeOrders()
        }
        ORDERS = {}
        MASTER_ORDER_ID = null
        //console.timeEnd('run')
        await run()
    } catch (error) {
        systemLog("error", String(error))
        await run();
    }
}


init()

process.on('SIGINT', async () => {
    console.log(`\n\n`)
    systemLog("warning", `[PLEASE HOLD, DO NOT SPAM EXIT]`)
    systemLog("info", `Exiting bot..., stopping bot cycle, cancelling any limit orders and placing final market orders...`)
    process.env.ON_KILL = true
});