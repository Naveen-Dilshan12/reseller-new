'use client'

import React, { createContext, useContext, useEffect, useState } from 'react'

export type Language = 'en' | 'si'

export interface I18nContextType {
  language: Language
  setLanguage: (lang: Language) => void
  t: (key: string, params?: Record<string, string | number>) => string
}

const STORAGE_KEY = 'hexalyte-language-preference'

const TRANSLATIONS: Record<Language, Record<string, string>> = {
  en: {
    // Brand & Header
    'brand.title': 'Hexalyte Partner',
    'brand.subtitle': 'Partner Console',
    'header.activeStatus': 'Active Partner',
    'header.activate': '+ Activate',
    'header.signOut': 'Sign out',
    'header.partnerTier': 'Partner Tier',
    'header.partnerTierStatus': 'ACTIVE',
    'header.partnerTierDesc': 'Earn recurring monthly commissions on active SaaS customers.',
    'header.partnerTierNone': 'No level yet',
    'header.partnerTierRate': '{rate}% commission rate',
    'header.partnerTierFirst': '{rate}% on your first active customer',
    'nav.notifications': 'Notifications',

    // Navigation Groups & Items
    'nav.overview': 'Overview',
    'nav.customerOperations': 'Customer Operations',
    'nav.earningsGrowth': 'Earnings & Growth',
    'nav.settings': 'Settings',
    'nav.dashboard': 'Dashboard',
    'nav.products': 'SaaS Products',
    'nav.customers': 'My Customers',
    'nav.activations': 'Paid Activations',
    'nav.bankDetails': 'Our Bank Details',
    'nav.demos': 'Demo Requests',
    'nav.commissions': 'Commissions & Payouts',
    'nav.profile': 'Partner Profile',

    // Common Controls & Badges
    'common.loading': 'Loading…',
    'common.updating': 'Updating…',
    'common.retry': 'Retry',
    'common.viewAll': 'View all',
    'common.allStatuses': 'All statuses',
    'common.clearFilters': 'Clear filters',
    'common.date': 'Date',
    'common.product': 'SaaS product',
    'common.allProducts': 'All products',
    'common.from': 'From',
    'common.to': 'To',
    'common.active': 'Active',
    'common.pending': 'Pending',
    'common.completed': 'Completed',
    'common.failed': 'Failed',
    'common.cancelled': 'Cancelled',
    'common.search': 'Search',
    'common.actions': 'Actions',

    // Date Presets
    'preset.all': 'All time',
    'preset.today': 'Today',
    'preset.7d': 'Last 7 days',
    'preset.30d': 'Last 30 days',
    'preset.month': 'This month',
    'preset.lastMonth': 'Last month',
    'preset.year': 'This year',
    'preset.custom': 'Custom range',

    // Dashboard Header & CTAs
    'dash.title': 'Dashboard',
    'dash.metaPortal': 'Hexalyte Central · Sri Lanka Partner Portal',
    'dash.metaTimezone': 'LKR · Colombo (UTC+05:30)',
    'dash.hero.greeting': 'Good morning,',
    'dash.hero.welcome': 'Welcome back, {name}!',
    'dash.hero.subtitle': 'Here is your partner business overview. Keep growing with Hexalyte.',
    'dash.welcome': 'Welcome back, {name}. Here is your partner business overview.',
    'dash.becomeReseller': 'Become a Partner',
    'dash.newDemoRequestBtn': 'New Demo Request',
    'dash.newActivationBtn': 'New activation',

    // Reseller Verification & Status Cards
    'dash.onboarding.underReviewTitle': 'Pending Admin Review',
    'dash.onboarding.underReviewBadge': 'PENDING ADMIN REVIEW',
    'dash.onboarding.underReviewDesc': 'Your partner application for {name} ({code}) has been submitted and is currently being reviewed by Hexalyte administrators. You will receive an email once approved.',
    'dash.onboarding.rejectedTitle': 'Application Not Approved',
    'dash.onboarding.rejectedBadge': 'NOT APPROVED',
    'dash.onboarding.rejectedDesc': 'Your partner application was not approved. You can submit an updated application with verified business credentials.',
    'dash.onboarding.reapplyBtn': 'Reapply Now',
    'dash.onboarding.verifiedTitle': 'Complete Your Partner Application',
    'dash.onboarding.verifiedBadge': 'VERIFIED ACCOUNT',
    'dash.onboarding.verifiedDesc': 'You have verified your email address. Complete our 4-step partner onboarding to unlock enterprise SaaS distribution, customer demos, paid activations, and monthly recurring commissions.',
    'dash.onboarding.startAppBtn': 'Start Partner Application (4 Steps)',

    // KPI Cards
    'dash.kpi.totalCustomers': 'Total Customers',
    'dash.kpi.totalCustomersBadge': 'All accounts',
    'dash.kpi.totalCustomersHint': 'All registered client accounts',
    'dash.kpi.scope': 'Scope: {name}',
    'dash.kpi.activeCustomers': 'Active Customers',
    'dash.kpi.activeCustomersBadge': 'Billable',
    'dash.kpi.activeCustomersHintSingle': '1 active subscription',
    'dash.kpi.activeCustomersHintPlural': '{count} active subscriptions',
    'dash.kpi.pendingActivations': 'Pending Activations',
    'dash.kpi.pendingActivationsBadge': 'In Review',
    'dash.kpi.pendingActivationsHint': 'Awaiting payment review',
    // This tile shows commission already PAID OUT to the reseller (not pending/payable amounts).
    'dash.kpi.commissionPaid': 'Commission Paid',
    'dash.kpi.commissionPaidHint': 'Paid out to you so far',
    'dash.error.load': 'Could not load your dashboard. Please try again.',
    'dash.rates.unavailable': 'Commission rates could not be loaded right now, so upcoming-level rates are hidden.',

    // Partner Level & Growth Progress
    'dash.growth.title': 'Partner Level & Growth Progress',
    'dash.growth.subtitle': 'Your progress towards the next partner level',
    'dash.growth.tierActiveBadge': 'Tier Active',
    'dash.growth.subtitleSingle': '1 eligible active customer contributing to your partner tier',
    'dash.growth.subtitlePlural': '{count} eligible active customers contributing to your partner tier',
    'dash.growth.pendingLabel': 'Pending Activations:',
    'dash.growth.pendingBadge': '{count} pending',
    'dash.growth.currentLevel': 'Current Level',
    'dash.growth.currentCommission': 'Current Commission',
    'dash.growth.nextLevel': 'Next Level',
    'dash.growth.nextCommission': 'Next Commission',
    'dash.growth.standardPartner': 'No level yet',
    'dash.growth.qualifying': '{count} qualifying customers',
    'dash.growth.badges': 'Achievement badges',
    'dash.growth.leveledUp': 'Level up!',
    'dash.growth.maxLevelReached': 'Max Level Reached',
    'dash.growth.targetText': '{count} more active customers',
    'dash.growth.toReach': 'to reach {level}',
    'dash.growth.progressCount': '{current} of {target} active customers',
    'dash.growth.progressCountFull': '{current} active customers',
    'dash.growth.moreNeeded': '{needed} more needed to reach {nextLevel} ({rate})',
    'dash.growth.topLevelReached': 'Top partner level reached! Maximum {rate} tier commission unlocked.',
    'dash.growth.percentComplete': '{percent}% Complete',
    'dash.growth.footerNote': 'Commissions automatically calculated upon monthly invoice verification.',
    'dash.growth.viewLedger': 'View Commission Ledger & Payouts',

    // Business Analytics
    'dash.analytics.title': 'Business Analytics',
    'dash.analytics.subtitle': 'Real-time client growth trends and verified monthly earnings',
    'dash.analytics.customerGrowth': 'Customer Growth',
    'dash.analytics.customerGrowthDesc': 'Newly registered customers by month',
    'dash.analytics.commissions': 'Commission Earnings',
    'dash.analytics.commissionsDesc': 'Monthly earned commissions & paid transfers',
    'dash.analytics.earned': 'Earned',
    'dash.analytics.paid': 'Paid Out',
    'dash.analytics.customers': 'Customers',
    'dash.analytics.clients': 'clients',
    'dash.analytics.range6m': 'Last 6 Months',
    'dash.analytics.emptyCustomerGrowth': 'Customer growth trends will appear once client accounts are created.',
    'dash.analytics.emptyCommissions': 'Commission analytics will appear once invoice payments are verified.',

    // Period Summary Strip
    'dash.period.newCustomers': 'new customers',
    'dash.period.activationRequests': 'activation requests',
    'dash.period.commissionEarned': 'commission earned',
    'dash.period.paidOut': 'paid out',

    // Recent Activity Panels
    'dash.recent.customersTitle': 'Recent Customers',
    'dash.recent.customersSub': 'Latest registered customers under your account',
    'dash.recent.activityTitle': 'Recent Activations',
    'dash.recent.activitySub': 'Latest paid activation requests',
    'dash.recent.activationsTitle': 'Recent activation requests',
    'dash.recent.commissionsTitle': 'Recent commission transactions',
    'dash.recent.emptyCustomers': 'No customers registered yet.',
    'dash.recent.noAccount': 'No SaaS account yet',
    'dash.recent.emptyActivity': 'No recent activation requests recorded.',
    'dash.recent.emptyActivations': 'No activation requests match these filters.',
    'dash.recent.emptyCommissions': 'No commission transactions match these filters.',
    'dash.recent.added': 'Added',
    'dash.recent.clawback': 'Clawback',
    'dash.recent.commissionRate': '{rate}% commission',
    'dash.recent.activationBadge': 'Activation',

    // Semantic Status Translations
    'status.PENDING': 'Pending',
    'status.ACTIVE': 'Active',
    'status.TRIAL': 'Trial',
    'status.PROVISIONED': 'Provisioned',
    'status.FAILED': 'Failed',
    'status.CANCELLED': 'Cancelled',
    'status.APPROVED': 'Approved',
    'status.UNDER_REVIEW': 'Under Review',
    'status.PENDING_REVIEW': 'Pending Review',
    'status.ACTIVATION_COMPLETED': 'Activated',
    'status.REJECTED': 'Rejected',
    'status.SUSPENDED': 'Suspended',
    'status.PAYABLE': 'Payable',
    'status.PAID': 'Paid',
    'status.REVERSED': 'Reversed',
  },
  si: {
    // Brand & Header
    'brand.title': 'Hexalyte හවුල්කරු',
    'brand.subtitle': 'හවුල්කරු පාලක පුවරුව',
    'header.activeStatus': 'සක්‍රීය හවුල්කරු',
    'header.activate': '+ සක්‍රිය කරන්න',
    'header.signOut': 'ඉවත් වන්න',
    'header.partnerTier': 'හවුල්කාර මට්ටම',
    'header.partnerTierStatus': 'සක්‍රීයයි',
    'header.partnerTierDesc': 'සක්‍රීය SaaS පාරිභෝගිකයින් සඳහා මාසික කොමිස් උපයන්න.',

    // Navigation Groups & Items
    'nav.overview': 'දළ විශ්ලේෂණය',
    'nav.customerOperations': 'පාරිභෝගික මෙහෙයුම්',
    'nav.earningsGrowth': 'ඉපැයීම් සහ වර්ධනය',
    'nav.settings': 'සැකසුම්',
    'nav.dashboard': 'උපකරණ පුවරුව',
    'nav.products': 'SaaS මෘදුකාංග',
    'nav.customers': 'මගේ පාරිභෝගිකයන්',
    'nav.activations': 'ගෙවීම් සක්‍රිය කිරීම්',
    'nav.bankDetails': 'අපගේ බැංකු විස්තර',
    'nav.demos': 'ඩෙමෝ ඉල්ලීම්',
    'nav.commissions': 'කොමිස් සහ ගෙවීම්',
    'nav.profile': 'හවුල්කරු පැතිකඩ',

    // Common Controls & Badges
    'common.loading': 'පූරණය වෙමින් පවතී…',
    'common.updating': 'යාවත්කාලීන වෙමින් පවතී…',
    'common.retry': 'නැවත උත්සාහ කරන්න',
    'common.viewAll': 'සියල්ල බලන්න',
    'common.allStatuses': 'සියලු තත්වයන්',
    'common.clearFilters': 'පෙරහන් ඉවත් කරන්න',
    'common.date': 'දිනය',
    'common.product': 'SaaS මෘදුකාංගය',
    'common.allProducts': 'සියලු මෘදුකාංග',
    'common.from': 'සිට',
    'common.to': 'දක්වා',
    'common.active': 'සක්‍රීය',
    'common.pending': 'පොරොත්තුවෙන්',
    'common.completed': 'සම්පූර්ණයි',
    'common.failed': 'අසාර්ථකයි',
    'common.cancelled': 'අවලංගුයි',
    'common.search': 'සොයන්න',
    'common.actions': 'ක්‍රියාකාරකම්',

    // Date Presets
    'preset.all': 'සියලු කාලය',
    'preset.today': 'අද',
    'preset.7d': 'පසුගිය දින 7',
    'preset.30d': 'පසුගිය දින 30',
    'preset.month': 'මෙම මාසය',
    'preset.lastMonth': 'පසුගිය මාසය',
    'preset.year': 'මෙම වසර',
    'preset.custom': 'අභිරුචි පරාසය',

    // Dashboard Header & CTAs
    'dash.title': 'උපකරණ පුවරුව',
    'dash.metaPortal': 'Hexalyte Central · ශ්‍රී ලංකා හවුල්කාර ද්වාරය',
    'dash.metaTimezone': 'රුපියල් · කොළඹ (UTC+05:30)',
    'dash.hero.greeting': 'සුබ උදෑසනක්,',
    'dash.hero.welcome': 'නැවත සාදරයෙන් පිළිගනිමු, {name}!',
    'dash.hero.subtitle': 'ඔබගේ හවුල්කරු ව්‍යාපාරික දළ විශ්ලේෂණය මෙන්න. Hexalyte සමඟ වර්ධනය වන්න.',
    'dash.welcome': 'ආයුබෝවන්, {name}. ඔබගේ හවුල්කරු ව්‍යාපාරික දළ විශ්ලේෂණය මෙන්න.',
    'dash.becomeReseller': 'හවුල්කරුවෙකු වන්න',
    'dash.newDemoRequestBtn': 'නව ඩෙමෝ ඉල්ලීමක්',
    'dash.newActivationBtn': 'නව සක්‍රිය කිරීමක්',

    // Reseller Verification & Status Cards
    'dash.onboarding.underReviewTitle': 'පරිපාලක සමාලෝචනය බලාපොරොත්තුවෙන්',
    'dash.onboarding.underReviewBadge': 'පරිපාලක සමාලෝචනය බලාපොරොත්තුවෙන්',
    'dash.onboarding.underReviewDesc': '{name} ({code}) සඳහා ඔබේ හවුල්කාර අයදුම්පත ඉදිරිපත් කර ඇති අතර එය Hexalyte පරිපාලකයින් විසින් සමාලෝචනය කරනු ලැබේ. අනුමත වූ පසු ඔබට විද්‍යුත් තැපෑලක් ලැබෙනු ඇත.',
    'dash.onboarding.rejectedTitle': 'අයදුම්පත අනුමත නොවීය',
    'dash.onboarding.rejectedBadge': 'අනුමත නොවීය',
    'dash.onboarding.rejectedDesc': 'ඔබේ හවුල්කරු අයදුම්පත අනුමත නොවීය. තහවුරු කළ ව්‍යාපාරික තොරතුරු සමඟ නැවත අයදුම්පතක් ඉදිරිපත් කළ හැකිය.',
    'dash.onboarding.reapplyBtn': 'නැවත අයදුම් කරන්න',
    'dash.onboarding.verifiedTitle': 'ඔබගේ හවුල්කරු අයදුම්පත සම්පූර්ණ කරන්න',
    'dash.onboarding.verifiedBadge': 'තහවුරු කළ ගිණුම',
    'dash.onboarding.verifiedDesc': 'ඔබේ විද්‍යුත් තැපෑල තහවුරු කර ඇත. SaaS බෙදාහැරීම, ඩෙමෝ ඉල්ලීම්, ගෙවුම් සක්‍රිය කිරීම් සහ මාසික කොමිස් ලබාගැනීම සඳහා පියවර 4ක ලියාපදිංචිය සම්පූර්ණ කරන්න.',
    'dash.onboarding.startAppBtn': 'ලියාපදිංචිය ආරම්භ කරන්න (පියවර 4)',

    // KPI Cards
    'dash.kpi.totalCustomers': 'මුළු පාරිභෝගිකයින්',
    'dash.kpi.totalCustomersBadge': 'සියලු ගිණුම්',
    'dash.kpi.totalCustomersHint': 'ලියාපදිංචි සියලු පාරිභෝගික ගිණුම්',
    'dash.kpi.scope': 'විෂය පථය: {name}',
    'dash.kpi.activeCustomers': 'සක්‍රීය පාරිභෝගිකයින්',
    'dash.kpi.activeCustomersBadge': 'බිල්පත් කළ හැකි',
    'dash.kpi.activeCustomersHintSingle': '1 සක්‍රීය දායකත්වයක්',
    'dash.kpi.activeCustomersHintPlural': 'සක්‍රීය දායකත්වයන් {count}ක්',
    'dash.kpi.pendingActivations': 'පොරොත්තු සක්‍රිය කිරීම්',
    'dash.kpi.pendingActivationsBadge': 'සමාලෝචනයේ',
    'dash.kpi.pendingActivationsHint': 'ගෙවීම් සමාලෝචනය බලාපොරොත්තුවෙන්',
    // 'dash.kpi.commissionPaid' / '...Hint' intentionally have no Sinhala entry yet: the old
    // "මුළු ඉපැයීම්" (total earnings) label was inaccurate for a paid-out figure, so those strings
    // fall back to English until a reviewed translation is added.

    // Partner Level & Growth Progress
    'dash.growth.title': 'හවුල්කාර මට්ටම සහ වර්ධන ප්‍රගතිය',
    'dash.growth.subtitle': 'මීළඟ හවුල්කරු මට්ටම කරා ඔබගේ ප්‍රගතිය',
    'dash.growth.tierActiveBadge': 'ශ්‍රේණිය සක්‍රීයයි',
    'dash.growth.subtitleSingle': 'ඔබේ හවුල්කරු මට්ටමට දායක වන 1 සක්‍රීය පාරිභෝගිකයෙක්',
    'dash.growth.subtitlePlural': 'ඔබේ හවුල්කරු මට්ටමට දායක වන සක්‍රීය පාරිභෝගිකයින් {count}ක්',
    'dash.growth.pendingLabel': 'පොරොත්තුවන සක්‍රිය කිරීම්:',
    'dash.growth.pendingBadge': '{count}ක් පොරොත්තුවෙන්',
    'dash.growth.currentLevel': 'වත්මන් මට්ටම',
    'dash.growth.currentCommission': 'වත්මන් කොමිස් අනුපාතය',
    'dash.growth.nextLevel': 'ඊළඟ මට්ටම',
    'dash.growth.nextCommission': 'ඊළඟ කොමිස් අනුපාතය',
    'dash.growth.standardPartner': 'තවමත් මට්ටමක් නැත',
    'dash.growth.qualifying': 'සුදුසුකම් ලත් පාරිභෝගිකයින් {count}ක්',
    'dash.growth.badges': 'ජයග්‍රහණ ලාංඡන',
    'dash.growth.leveledUp': 'මට්ටම ඉහළ ගියා!',
    'dash.growth.maxLevelReached': 'උපරිම මට්ටමට ළඟා වී ඇත',
    'dash.growth.targetText': 'තවත් සක්‍රීය පාරිභෝගිකයින් {count} දෙනෙකු',
    'dash.growth.toReach': '{level} වෙත ළඟා වීමට',
    'dash.growth.progressCount': 'සක්‍රීය පාරිභෝගිකයින් {current} / {target}',
    'dash.growth.progressCountFull': 'සක්‍රීය පාරිභෝගිකයින් {current}',
    'dash.growth.moreNeeded': '{nextLevel} ({rate}) වෙත ළඟාවීමට තවත් {needed}ක් අවශ්‍යයි',
    'dash.growth.topLevelReached': 'ඉහළම හවුල්කාර මට්ටමට ළඟා විය! උපරිම {rate} කොමිස් අනුපාතය සක්‍රීයයි.',
    'dash.growth.percentComplete': '{percent}% සම්පූර්ණයි',
    'dash.growth.footerNote': 'මාසික ඉන්වොයිස් තහවුරු කිරීමෙන් පසු කොමිස් මුදල් ස්වයංක්‍රීයව ගණනය කෙරේ.',
    'dash.growth.viewLedger': 'කොමිස් ලෙජරය සහ ගෙවීම් බලන්න',

    // Business Analytics
    'dash.analytics.title': 'ව්‍යාපාරික විශ්ලේෂණ',
    'dash.analytics.subtitle': 'තත්‍ය කාලීන පාරිභෝගික වර්ධන ප්‍රවණතා සහ තහවුරු කළ මාසික ඉපැයීම්',
    'dash.analytics.customerGrowth': 'පාරිභෝගික වර්ධනය',
    'dash.analytics.customerGrowthDesc': 'මාසිකව ලියාපදිංචි වූ නව පාරිභෝගිකයින්',
    'dash.analytics.commissions': 'කොමිස් ඉපැයීම්',
    'dash.analytics.commissionsDesc': 'මාසිකව උපයාගත් කොමිස් සහ ගෙවූ මාරුකිරීම්',
    'dash.analytics.earned': 'උපයාගත්',
    'dash.analytics.paid': 'ගෙවා ඇති',
    'dash.analytics.customers': 'පාරිභෝගිකයින්',
    'dash.analytics.clients': 'පාරිභෝගිකයින්',
    'dash.analytics.range6m': 'පසුගිය මාස 6',
    'dash.analytics.emptyCustomerGrowth': 'නව පාරිභෝගික ගිණුම් නිර්මාණය කළ පසු වර්ධන ප්‍රස්ථාරය මෙහි දිස්වනු ඇත.',
    'dash.analytics.emptyCommissions': 'ඉන්වොයිස් ගෙවීම් තහවුරු කළ පසු කොමිස් විශ්ලේෂණ මෙහි දිස්වනු ඇත.',

    // Period Summary Strip
    'dash.period.newCustomers': 'නව පාරිභෝගිකයින්',
    'dash.period.activationRequests': 'සක්‍රිය කිරීම් ඉල්ලීම්',
    'dash.period.commissionEarned': 'උපයාගත් කොමිස් මුදල',
    'dash.period.paidOut': 'ගෙවා ඇති මුදල',

    // Recent Activity Panels
    'dash.recent.customersTitle': 'මෑත පාරිභෝගිකයින්',
    'dash.recent.customersSub': 'ඔබගේ ගිණුම යටතේ ලියාපදිංචි වූ නවතම පාරිභෝගිකයින්',
    'dash.recent.activityTitle': 'මෑත සක්‍රිය කිරීම්',
    'dash.recent.activitySub': 'නවතම සක්‍රිය කිරීමේ ඉල්ලීම්',
    'dash.recent.activationsTitle': 'මෑත සක්‍රිය කිරීම් ඉල්ලීම්',
    'dash.recent.commissionsTitle': 'මෑත කොමිස් ගනුදෙනු',
    'dash.recent.emptyCustomers': 'තවමත් ලියාපදිංචි වූ පාරිභෝගිකයින් නොමැත.',
    'dash.recent.noAccount': 'තවමත් SaaS ගිණුමක් නැත',
    'dash.recent.emptyActivity': 'මෑත සක්‍රිය කිරීමේ ඉල්ලීම් කිසිවක් නැත.',
    'dash.recent.emptyActivations': 'මෙම පෙරහන් වලට ගැළපෙන සක්‍රිය කිරීම් ඉල්ලීම් නොමැත.',
    'dash.recent.emptyCommissions': 'මෙම පෙරහන් වලට ගැළපෙන කොමිස් ගනුදෙනු නොමැත.',
    'dash.recent.added': 'එකතු කළ දිනය',
    'dash.recent.clawback': 'ආපසු අය කිරීම',
    'dash.recent.commissionRate': '{rate}% කොමිස් මුදල',
    'dash.recent.activationBadge': 'සක්‍රිය කිරීම',

    // Semantic Status Translations
    'status.PENDING': 'පොරොත්තුවෙන්',
    'status.ACTIVE': 'සක්‍රීයයි',
    'status.TRIAL': 'අත්හදා බැලීම',
    'status.PROVISIONED': 'ලබාදී ඇත',
    'status.FAILED': 'අසාර්ථකයි',
    'status.CANCELLED': 'අවලංගුයි',
    'status.APPROVED': 'අනුමතයි',
    'status.UNDER_REVIEW': 'සමාලෝචනය වෙමින්',
    'status.PENDING_REVIEW': 'සමාලෝචනයට පොරොත්තුවෙන්',
    'status.ACTIVATION_COMPLETED': 'සක්‍රිය කර ඇත',
    'status.REJECTED': 'ප්‍රතික්ෂේපිතයි',
    'status.SUSPENDED': 'අත්හිටුවා ඇත',
    'status.PAYABLE': 'ගෙවිය යුතුයි',
    'status.PAID': 'ගෙවා ඇත',
    'status.REVERSED': 'ආපසු හරවන ලද',
  },
}

/** A translation as shipped with the app (not an admin override). The admin settings page shows these as the defaults. */
export const builtInText = (language: Language, key: string): string => TRANSLATIONS[language][key] ?? TRANSLATIONS.en[key] ?? key

const I18nContext = createContext<I18nContextType>({
  language: 'en',
  setLanguage: () => {},
  t: (key: string) => key,
})

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<Language>('en')
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY) as Language | null
      if (stored === 'si' || stored === 'en') {
        setLanguageState(stored)
        document.documentElement.setAttribute('lang', stored)
        document.documentElement.setAttribute('data-lang', stored)
      } else {
        document.documentElement.setAttribute('lang', 'en')
        document.documentElement.setAttribute('data-lang', 'en')
      }
    } catch {
      // Ignore localStorage access failures
    }
    setMounted(true)
  }, [])

  const setLanguage = (lang: Language) => {
    setLanguageState(lang)
    try {
      localStorage.setItem(STORAGE_KEY, lang)
      document.documentElement.setAttribute('lang', lang)
      document.documentElement.setAttribute('data-lang', lang)
    } catch {
      // Ignore
    }
  }

  const t = (key: string, params?: Record<string, string | number>): string => {
    const dict = TRANSLATIONS[language] || TRANSLATIONS.en
    let str = dict[key] || TRANSLATIONS.en[key] || key
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
      })
    }
    return str
  }

  return (
    <I18nContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </I18nContext.Provider>
  )
}

export function useLanguage() {
  return useContext(I18nContext)
}
