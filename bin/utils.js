const BigNumber = require('bignumber.js')
const fs = require('fs-extra')
const os = require('os')
const axios = require('axios')

LOG_PATH = "/tmp/cross-exchange-arb-bot.log"

async function getExternalIpAddress() {
    try {
        let query = await axios.get("https://myexternalip.com/raw")
        return query.data
    } catch (error) {
        return '0.0.0.0'
        //throw error
    }
}

function usdToMyr(value = 0) {
    try {
        let valueReal = new BigNumber(value).multipliedBy(new BigNumber(process.env.USDTMYR)).toFixed(2)
        return parseFloat(valueReal).toString()
    } catch (error) {
        throw error
    }
}

function myrToUsd(value = 0) {
    try {
        let valueReal = new BigNumber(value).dividedBy(new BigNumber(process.env.USDTMYR)).toFixed(2)
        return parseFloat(valueReal).toString()
    } catch (error) {
        throw error
    }
}

//remove trailling zeros
function rtz(value = 0) {
    try {
        return parseFloat(value).toString()
    } catch (error) {
        throw error
    }
}

function computeBidAskPercent(ticker, bidEx, askEx, asset) {
    try {

        let bidExBidPrice = ticker[bidEx][asset].bid
        let askExAskPrice = ticker[askEx][asset].ask

        if (bidEx !== 'luno') { bidExBidPrice = usdToMyr(bidExBidPrice) }
        if (askEx !== 'luno') { askExAskPrice = usdToMyr(askExAskPrice) }

        let minusBN = new BigNumber(bidExBidPrice).minus(new BigNumber(askExAskPrice))
        let percentBN = ((minusBN).dividedBy(new BigNumber(bidExBidPrice))).multipliedBy(new BigNumber(100))
        return percentBN.toFixed(4)
    } catch (error) {
        throw error
    }
}

function computeAskAskPercent(ticker, askEx1, askEx2, asset) {
    try {

        let baseAskExAskPrice = ticker[askEx1][asset].ask
        let askExAskPrice = ticker[askEx2][asset].ask

        if (askEx1 !== 'luno') { baseAskExAskPrice = usdToMyr(baseAskExAskPrice) }
        if (askEx2 !== 'luno') { askExAskPrice = usdToMyr(askExAskPrice) }

        let minusBN = new BigNumber(baseAskExAskPrice).minus(new BigNumber(askExAskPrice))
        let percentBN = ((minusBN).dividedBy(new BigNumber(baseAskExAskPrice))).multipliedBy(new BigNumber(100))
        return percentBN.toFixed(4)
    } catch (error) {
        throw error
    }
}

function computeBidBidPercent(ticker, bidEx1, bidEx2, asset) {
    try {

        let basebidExBidPrice = ticker[bidEx1][asset].ask
        let bidExbidPrice = ticker[bidEx2][asset].ask

        if (bidEx1 !== 'luno') { basebidExBidPrice = usdToMyr(basebidExBidPrice) }
        if (bidEx2 !== 'luno') { bidExbidPrice = usdToMyr(bidExbidPrice) }

        let minusBN = new BigNumber(basebidExBidPrice).minus(new BigNumber(bidExbidPrice))
        let percentBN = ((minusBN).dividedBy(new BigNumber(basebidExBidPrice))).multipliedBy(new BigNumber(100))
        return percentBN.toFixed(4)
    } catch (error) {
        throw error
    }
}

function currTime() {
    var offset = '+8'


    var d = new Date()
    var utc = d.getTime() + (d.getTimezoneOffset() * 60000)
    var nd = new Date(utc + (3600000 * offset))
    var datetime = nd.toLocaleString()

    return datetime
}

function epochToDatetime(timestamp, offset) {
    var offsetHours = offset || '+8'

    var d = new Date()
    var utc = Number(timestamp) + (d.getTimezoneOffset() * 60000)
    var nd = new Date(utc + (3600000 * offsetHours))

    return nd.toLocaleString()
}

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}


module.exports = {
    getExternalIpAddress,
    usdToMyr,
    myrToUsd,
    rtz,
    computeBidAskPercent,
    computeAskAskPercent,
    computeBidBidPercent,
    currTime,
    epochToDatetime,
    sleep,
    LOG_PATH
}