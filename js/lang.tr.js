/* Moon — Turkish catalogue.
 *
 * Flat, dot-namespaced keys. Flat because a missing-key diff is then one line
 * of code (see I18n._verify) and because lookup is a single property read.
 *
 * Voice: an instrument, not a coach. Second person, no exclamation marks, no
 * emoji, no praise, no scolding. Verbs of measurement: kaldı, geçti, aştın,
 * ölçüldü, kaydedildi. Every error says three things: what happened, why, and
 * what you can do now.
 *
 * Two rules that shape the Turkish wording:
 *  - No sentence is built by concatenation, so every string is a whole sentence
 *    with {placeholders}. A suffix glued to a number breaks Turkish: "%70'i" is
 *    right but "%76'sı" is, so no percentage ever takes a suffix here — the
 *    suffix rides on a following word ("%70 kadarı") and stays correct for
 *    every number.
 *  - ".one" carries the same sentence as ".other": Turkish takes no plural
 *    suffix after a numeral ("3 kayıt", never "3 kayıtlar"). The pair exists so
 *    that this catalogue and lang.en.js stay key-for-key identical and
 *    I18n._verify() can prove it; the selector always picks ".other" for tr.
 *
 * Keys ending in ".short" are the 320px variants: at most 48 characters.
 */
(function (global) {
  "use strict";

  var Moon = global.Moon || {};
  global.Moon = Moon;
  Moon.Lang = Moon.Lang || {};

  Moon.Lang.tr = {

    /* ---------------------------------------------------------- about ---- */

    "about.appTitle": "Moon — bütçe defteri",
    "about.title": "Moon nedir",
    "about.body1": "Moon tek bir HTML dosyasından açılan bir bütçe defteridir. Sunucusu yok, hesabı yok, ağa hiç istek göndermez.",
    "about.body2": "Yazdığın her şey bu tarayıcının kendi deposunda durur. Kayıtlarını senden başka kimse görmez, çünkü gidecek bir yer yok.",
    "about.body3": "Veriyi taşımak için Veri bölümünden JSON olarak indirirsin; başka bir tarayıcıda aynı bölümden geri yüklersin.",

    /* ------------------------------------------------------------ nav ---- */

    "nav.panel": "Panel",
    "nav.ledger": "Defter",
    "nav.limits": "Limitler",
    "nav.recurring": "Tekrar",
    "nav.goals": "Hedefler",
    "nav.debts": "Borç",
    "nav.accounts": "Hesaplar",
    "nav.investments": "Yatırımlar",
    "nav.data": "Veri",
    "nav.more": "Daha",

    /* --------------------------------------------------------- common ---- */

    "common.save": "Kaydet",
    "common.cancel": "Vazgeç",
    "common.more": "Daha",
    "common.details": "Ayrıntılar",
    "common.notSaved": "Değişiklik kaydedilmedi, eski değer geri alındı.",
    "limits.edit": "Dönem limitini değiştir: {amount}",
    "common.delete": "Sil",
    "common.edit": "Düzenle",
    "common.copy": "Kopyala",
    "common.close": "Kapat",
    "common.add": "Ekle",
    "common.confirm": "Onayla",
    "common.undo": "Geri al",
    "common.all": "Tümü",
    "common.unclassified": "Sınıflandırılmamış",
    "common.today": "Bugün",
    "common.yesterday": "Dün",
    "common.expense": "Gider",
    "common.income": "Gelir",
    "common.fixed": "Sabit",
    "common.variable": "Değişken",
    "common.none": "Yok",
    "common.showNumbers": "Sayıları göster",
    "common.noNumbers": "Gösterilecek sayı yok.",
    "common.hideNumbers": "Sayıları gizle",
    "common.loading": "Okunuyor",
    "common.search": "Ara",
    "common.period": "Dönem",
    "common.currency": "Para birimi",
    "common.language": "Dil",
    "common.theme": "Tema",
    "common.theme.system": "Sistem",
    /* Buradaki anahtar saklanan değerin adıdır, gösterilen kelimenin değil, ve
       §2.2 iki yüzeyi yeniden adlandırırken saklanan dial ile paper değerlerine
       dokunmadı: eski bir sürümün yazdığı ayar hâlâ okunuyor. Dolayısıyla dial
       artık Gece, paper artık Şafak diye okunur. .night ve .dawn aynı
       kelimeleri bundan sonra kullanılacak adlarla taşıyor, böylece tema
       denetimi hangi anahtarı çağırırsa çağırsın ekranda aynı şey yazıyor. */
    "common.theme.dial": "Gece",
    "common.theme.paper": "Şafak",
    "common.theme.night": "Gece",
    "common.theme.dawn": "Şafak",
    "common.theme.prism": "Prizma",
    "common.lang.tr": "Türkçe",
    "common.lang.en": "İngilizce",
    "common.dayCount.one": "{count} gün",
    "common.dayCount.other": "{count} gün",
    "common.undoSeconds": "{seconds} saniye",

    /* ---------------------------------------------------------- panel ---- */

    "panel.dailyAllowance": "Kalan günlük pay",
    "panel.dayCount": "{dayIndex}/{days} gün",

    "panel.state.ok.label": "Kalan günlük pay",
    "panel.state.ok.body": "{days} günde {amount} kaldı.",
    "panel.state.ok.body.short": "{days} günde {amount}.",

    "panel.state.noLimits.label": "Bu dönem harcanan",
    "panel.state.noLimits.body": "Henüz limit koymadın, bu yüzden günlük pay ölçülemiyor. Bir limit koyduğun an bu sayı paya döner.",
    "panel.state.noLimits.body.short": "Limit yok, pay ölçülemiyor.",
    "panel.state.noLimits.action": "Limit koy",

    "panel.state.overspent.label": "Limit aşımı",
    "panel.state.overspent.body": "Limit toplamını {amount} aştın, kalan {days} gün limitsiz.",
    "panel.state.overspent.body.short": "{amount} aştın, {days} gün limitsiz.",

    "panel.state.lastDay.label": "Bugünün payı",
    "panel.state.lastDay.body": "Bugün dönemin son günü, kalan {amount}.",
    "panel.state.lastDay.body.short": "Son gün, kalan {amount}.",

    "panel.state.pastPeriod.label": "Dönem toplamı",
    "panel.state.pastPeriod.body": "{period} kapandı. Limitlerinin %{pct} kadarını kullandın.",
    "panel.state.pastPeriod.body.short": "{period} kapandı, limitin %{pct} kadarı.",

    "panel.spentToday": "Bugün {spent} harcandı, payın {left} kaldı.",
    "panel.spentToday.short": "Bugün {spent}, kalan {left}.",

    "panel.paceLine": "Ayın %{periodPct} kadarı geçti, limitlerinin %{spentPct} kadarını kullandın.",
    "panel.paceLine.short": "Dönem %{periodPct}, limit %{spentPct}.",

    "panel.fixedReserved.one": "{count} sabit ödeme, {amount} ayrıldı.",
    "panel.fixedReserved.other": "{count} sabit ödeme, {amount} ayrıldı.",
    "panel.fixedReserved.short": "Sabit ödemeler: {amount} ayrıldı.",

    "panel.entryCount.one": "Bu dönem {count} kayıt girildi.",
    "panel.entryCount.other": "Bu dönem {count} kayıt girildi.",

    "panel.pending.one": "{count} tekrarlayan ödeme bekliyor, toplam {amount}.",
    "panel.pending.other": "{count} tekrarlayan ödeme bekliyor, toplam {amount}.",
    "panel.pending.short": "{count} ödeme bekliyor.",
    "panel.pending.action": "Bekleyenleri yaz",
    "panel.pending.review": "Tekrar bölümünde bak",

    "panel.moreCategories.one": "{count} kategori daha",
    "panel.moreCategories.other": "{count} kategori daha",

    "panel.dropHint": "Banka ekstreni bu şeridin üstüne bırakabilirsin.",
    "panel.dropActive": "Dosyayı bırak, sütunları birlikte eşleştiririz.",

    "panel.chart.trail.title": "Pay izi",
    "panel.chart.trail.body": "Dönemin her günü için o gün ölçülen günlük pay. Yatay çizgi dönem başındaki paydır: çizgi üstte kaldıysa pay büyüdü, altına indiyse eridi.",
    "panel.chart.flow.title": "Gün sismografı",
    "panel.chart.flow.body": "Her gün için tek çubuk: orta hattın üstü gelir, altı gider. Hafta sonları taban hattında koyu tik alır.",
    "panel.chart.cumulative.title": "Birikimli dönem",
    "panel.chart.cumulative.body": "Dönem başından bugüne toplam gider. Köşegen limitin gün gün dağılımı, noktalı iz geçen dönem.",
    "panel.chart.cumulative.crossed": "Hız {date} günü aşıldı.",
    "panel.chart.year.title": "Yıl ızgarası",
    "panel.chart.year.body": "Son on iki dönem ve kategoriler. Hücre yoğunluğu renkle değil çizgi sıklığıyla verilir; siyah beyaz da okunur.",
    "panel.chart.reading": "{date} — {amount}",

    /* --------------------------------------------------------- ledger ---- */

    "ledger.title": "Defter",
    "ledger.detail.created": "Yazıldığı an",
    "ledger.detail.mark": "Kenar işareti",
    "ledger.detail.source": "Kaynağı",
    "ledger.keys": "Listede yukarı ve aşağı ok tuşlarıyla gezin: Boşluk satırı seçer, Enter düzenler, Delete siler, sağ ok satırın eylemlerine girer.",
    "ledger.filter.search": "Ara",
    "ledger.filter.search.hint": "Açıklama ve kategori içinde arar.",
    "ledger.filter.period": "Dönem",
    "ledger.filter.category": "Kategori",
    "ledger.filter.category.all": "Tüm kategoriler",
    "ledger.filter.direction": "Yön",
    "ledger.filter.direction.all": "Gider ve gelir",
    "ledger.filter.source": "Kaynak",
    "ledger.filter.source.all": "Tüm kaynaklar",
    "ledger.filter.source.manual": "Elle yazılan",
    "ledger.filter.source.csv": "Ekstreden gelen",
    "ledger.filter.source.recurring": "Tekrarlayan",
    "ledger.filter.source.sample": "Örnek",
    "ledger.filter.unconfirmed": "Yalnız onay bekleyenler",
    "ledger.filter.clear": "Filtreyi kaldır",
    "ledger.density": "Satır yoğunluğu",
    "ledger.density.dense": "Sık",
    "ledger.density.roomy": "Geniş",
    "ledger.summary": "{count} kayıttan {shown} tanesi gösteriliyor, toplam {total}.",
    "ledger.summary.short": "{shown}/{count} kayıt, {total}.",
    "ledger.count.one": "{count} kayıt",
    "ledger.count.other": "{count} kayıt",
    "ledger.total": "Toplam {total}",
    "ledger.dayTotal": "Gün toplamı {amount}",
    "ledger.col.date": "Tarih",
    "ledger.col.category": "Kategori",
    "ledger.col.note": "Açıklama",
    "ledger.col.amount": "Tutar",
    "ledger.action.edit": "Bu kaydı düzenle",
    "ledger.action.copy": "Bu kaydı kopyala",
    "ledger.action.delete": "Bu kaydı sil",
    "ledger.delete.title": "Kayıt silinsin mi?",
    "ledger.delete.body": "Bu kayıt silinsin mi? Sekiz saniye geri alma hakkın olacak.",
    "ledger.delete.confirm": "Sil",
    "ledger.deleted": "Kayıt silindi.",
    "ledger.deletedMany.one": "{count} kayıt silindi.",
    "ledger.deletedMany.other": "{count} kayıt silindi.",
    "ledger.undone": "Silme geri alındı.",
    "ledger.undo.hint": "Geri almak için {seconds} saniyen var.",
    "ledger.form.title.new": "Kayıt yaz",
    "ledger.form.title.edit": "Kaydı düzenle",
    "ledger.form.submit": "Kaydı yaz",
    "ledger.form.submit.edit": "Kaydı güncelle",
    "ledger.form.fixedHint": "Sabit işaretli kayıt günlük pay havuzuna girmez, ayrılmış tutarda görünür.",
    "ledger.saved": "Kaydedildi.",
    "ledger.copied": "Kayıt kopyalandı, tarihi bugüne alındı.",
    "ledger.unconfirmed.note": "Bu kayıt ekstreden geldi ve henüz onaylanmadı. Sağ kenardaki işaret onu gösterir.",
    "ledger.unconfirmedCount.one": "{count} kayıt onay bekliyor.",
    "ledger.unconfirmedCount.other": "{count} kayıt onay bekliyor.",
    "ledger.confirmAll": "Tümünü onayla",
    "ledger.confirmedCount.one": "{count} kayıt onaylandı.",
    "ledger.confirmedCount.other": "{count} kayıt onaylandı.",

    /* --------------------------------------------------------- limits ---- */

    "limits.title": "Limitler",
    /* Satırın yüzü aynı zamanda onu değiştiren düğme: basıldığında renk ve
       simge seçicileri açılıyor. Adı açılan şeyi söylüyor, çünkü düğmenin
       üstünde okunacak bir yazı değil tek bir nokta ve bir glif var. */
    "limits.category.appearance": "Renk ve simge",
    "limits.category.archive": "Arşivle",
    "limits.category.unarchive": "Arşivden çıkar",
    "limits.category.removed": "{name} silindi, {count} kayıt Diğer'e taşındı.",
    "limits.category.removed.one": "{name} silindi, {count} kayıt Diğer'e taşındı.",
    "limits.category.removed.other": "{name} silindi, {count} kayıt Diğer'e taşındı.",
    "limits.drift.ahead": "{amount} önde",
    "limits.drift.behind": "{amount} geride",
    "limits.drift.over": "{amount} aştın",
    "limits.drift.done": "tamamı ödendi",
    "limits.fixed.note": "Sabit giderler günlük pay havuzunda değil; ayrı tutulur.",
    "limits.year.title": "Yıl ızgarası",
    "limits.year.key": "Yoğunluk",
    "limits.suggest.title": "Limitleri verinden öner",
    "limits.suggest.empty": "Kapanmış dönemlerinde önerebileceğim bir harcama bulamadım.",
    "limits.suggest.basis.one": "{count} tam dönem, {entries} kayıt okundu. İçinde bulunduğun dönem sayılmadı.",
    "limits.suggest.basis.other": "{count} tam dönem, {entries} kayıt okundu. İçinde bulunduğun dönem sayılmadı.",
    "limits.suggest.confidence.high.one": "{count} dönemde ölçüldü",
    "limits.suggest.confidence.high.other": "{count} dönemde ölçüldü",
    "limits.suggest.confidence.medium.one": "{count} dönemde ölçüldü",
    "limits.suggest.confidence.medium.other": "{count} dönemde ölçüldü",
    "recurring.detect.periods.one": "{count} dönemde görüldü",
    "recurring.detect.periods.other": "{count} ayrı dönemde görüldü",
    "limits.suggest.body": "Kapanmış aylarına bakıp her kategori için bir limit öneririm. İstediğini değiştirir, istemediğini bırakırsın.",
    "limits.suggest.action": "Limitleri öner",
    "limits.suggest.apply": "Seçilenleri yaz",
    "limits.suggest.basis": "{count} tam dönem, {entries} kayıt okundu. İçinde bulunduğun dönem sayılmadı.",
    "limits.suggest.none": "Henüz kapanmış bir dönem yok. Bir dönem tamamlanınca limitleri senin verinden önerebilirim.",
    "limits.suggest.confidence.high": "{count} dönemde ölçüldü",
    "limits.suggest.confidence.medium": "{count} dönemde ölçüldü",
    "limits.suggest.confidence.low": "Tek dönemde görüldü, öneri zayıf",
    "limits.suggest.current": "şu an {amount}",
    "limits.suggest.applied.one": "{count} limit yazıldı.",
    "limits.suggest.applied.other": "{count} limit yazıldı.",
    "limits.reading.ahead": "{amount} önde",
    "limits.reading.behind": "{amount} geride",
    "limits.reading.over": "{amount} aştın",
    "limits.reading.done": "tamamı ödendi",
    "limits.pct": "%{pct}",
    "limits.pace": "beklenen %{pace}",
    "limits.overLine": "{name} limitini {amount} aştın. Limit gerçekçi değilse buradan güncelleyebilirsin.",
    "limits.total": "Limit toplamı {amount}",
    "limits.variableTotal": "Günlük paya giren havuz {amount}",
    "limits.form.title.new": "Limit koy",
    "limits.form.title.edit": "Limiti güncelle",
    "limits.form.amount": "Dönem limiti",
    "limits.form.amount.hint": "Bir dönemde bu kategoriye ayırdığın üst sınır.",
    "limits.form.remove": "Limiti kaldır",
    "limits.saved": "Limit kaydedildi.",
    "limits.removed": "Limit kaldırıldı.",
    "limits.aria.meter": "{name}: limitinin %{pct} kadarı kullanıldı, beklenen %{pace}.",
    "limits.aria.over": "{name}: limit {amount} aşıldı, ölçek dışına taşıyor.",
    "limits.aria.pace": "Hız işareti %{pace} noktasında.",
    "limits.overflow.note": "Aşan parça ölçeğin uç kapağını geçer ve sağdaki okuma sütununa taşar. Yüzde, tarama deseni ve cümle aynı şeyi söyler.",

    /* ------------------------------------------------------ recurring ---- */

    "recurring.title": "Tekrarlayan ödemeler",
    "recurring.detect.title": "Tekrar eden harcamalar",
    "recurring.detect.body": "Defterinde aylarca dönen kayıtlar var. Kural yazarsan sabit gidere taşınır ve günlük pay havuzundan çıkar.",
    "recurring.detect.none": "Tekrar eden bir harcama bulamadım.",
    "recurring.detect.periods": "{count} ayrı dönemde görüldü",
    "recurring.detect.varies": "Tutar oynuyor, medyan {amount}",
    "recurring.detect.hasRule": "Bunun için zaten bir kural var.",
    "recurring.detect.action": "Kural yaz ve sabitle",
    "recurring.detect.actionPlain": "Yalnız kural yaz",
    "recurring.detect.promoted": "Kural yazıldı. Bu dönem için yeni kayıt üretilmedi; sıradaki dönemde onayına düşer.",
    "recurring.detect.markedFixed.one": "{count} kayıt sabit işaretlendi, günlük pay havuzundan çıktı.",
    "recurring.detect.markedFixed.other": "{count} kayıt sabit işaretlendi, günlük pay havuzundan çıktı.",
    "recurring.active": "Etkin",
    "recurring.paused": "Durduruldu",
    "recurring.form.title.new": "Tekrarlayan ödeme yaz",
    "recurring.form.title.edit": "Tekrarlayan ödemeyi düzenle",
    "recurring.form.dayOfMonth": "Ayın günü",
    "recurring.form.dayOfMonth.hint": "Kısa aylarda ayın son gününe kırpılır, sonraki ay yine bu güne döner.",
    "recurring.form.fixedHint": "Sabit işaretli tekrarlayan ödeme günlük pay havuzuna girmez.",
    "recurring.next": "Sıradaki {date}, {amount}",
    "recurring.pendingCount.one": "{count} ödeme bekliyor.",
    "recurring.pendingCount.other": "{count} ödeme bekliyor.",
    "recurring.pendingSince": "{date} tarihinden beri bekliyor.",
    "recurring.write": "Bu ödemeyi yaz",
    "recurring.writeAll": "Bekleyenlerin tümünü yaz",
    "recurring.writtenCount.one": "{count} kayıt yazıldı.",
    "recurring.writtenCount.other": "{count} kayıt yazıldı.",
    "recurring.pause": "Durdur",
    "recurring.resume": "Sürdür",
    "recurring.pausedToast": "{name} durduruldu, yeni kayıt üretmez.",
    "recurring.resumedToast": "{name} sürdürüldü.",
    "recurring.saved": "Tekrarlayan ödeme kaydedildi.",
    "recurring.delete.title": "Tekrarlayan ödeme silinsin mi?",
    "recurring.delete.body": "Kural silinir. Bu kuraldan daha önce yazılmış kayıtlar defterde kalır.",

    /* ---------------------------------------------------------- goals ---- */

    "goals.title": "Hedefler",
    "goals.form.saved": "Baştaki birikim",
    "goals.form.title.new": "Hedef yaz",
    "goals.form.title.edit": "Hedefi düzenle",
    "goals.form.target": "Hedef tutar",
    "goals.form.dueDate": "Hedef tarihi",
    "goals.form.dueDate.hint": "Boş bırakırsan yalnız biriken tutarı ölçerim.",
    "goals.saved": "Hedef kaydedildi.",
    "goals.progress": "{saved} birikti, {remaining} kaldı.",
    "goals.progress.short": "{saved} / {target}",
    "goals.perMonth": "Ayda {amount} ayırırsan {date} tarihinde dolar.",
    "goals.monthsLeft.one": "{count} ay kaldı.",
    "goals.monthsLeft.other": "{count} ay kaldı.",
    "goals.done": "Hedef doldu: {amount} birikti, {days} gün erken.",
    "goals.overdue": "Tarih geçti, {remaining} eksik kaldı.",
    "goals.contribute": "Katkı yaz",
    "goals.contributionAdded": "Katkı kaydedildi.",
    "goals.contributionCount.one": "{count} katkı",
    "goals.contributionCount.other": "{count} katkı",
    "goals.delete.title": "Hedef silinsin mi?",
    "goals.delete.body": "Hedef ve katkı kayıtları silinir. Defterdeki harcamalara dokunulmaz.",
    "goals.note": "Hedefler günlük pay ve limit hesabına girmez.",

    /* ---------------------------------------------------------- debts ---- */

    "debts.title": "Borç ve alacak",
    "debts.direction.owedToMe": "Alacak",
    "debts.direction.iOwe": "Borç",
    "debts.form.title.new": "Borç ya da alacak yaz",
    "debts.form.title.edit": "Kaydı düzenle",
    "debts.form.person": "Kişi",
    "debts.form.direction": "Yön",
    "debts.form.dueDate": "Vade",
    "debts.form.dueDate.hint": "Boş bırakabilirsin.",
    "debts.saved": "Kaydedildi.",
    "debts.totals": "Alacak {owedToMe}, borç {iOwe}, net {net}.",
    "debts.totals.short": "Alacak {owedToMe}, borç {iOwe}.",
    "debts.openCount.one": "{count} kayıt açık.",
    "debts.openCount.other": "{count} kayıt açık.",
    "debts.settle": "Kapat",
    "debts.settled": "{date} tarihinde kapandı.",
    "debts.settledToast": "Kayıt kapatıldı.",
    "debts.reopen": "Yeniden aç",
    "debts.dueIn.one": "Vadeye {count} gün kaldı.",
    "debts.dueIn.other": "Vadeye {count} gün kaldı.",
    "debts.overdueBy.one": "Vade {count} gün geçti.",
    "debts.overdueBy.other": "Vade {count} gün geçti.",
    "debts.delete.title": "Kayıt silinsin mi?",
    "debts.delete.body": "Bu borç kaydı silinir. Defterdeki harcamalara dokunulmaz.",
    "debts.note": "Borç ve alacak günlük pay ve limit hesabına girmez.",

    /* ------------------------------------------------------- accounts ---- */

    "accounts.title": "Hesaplar",
    "accounts.name": "Hesap adı",
    /* Adı okunamayan bir kaydı onarırken Store bir ad yazmak zorunda; boş ad
       kartı adsız bir başkasından ayırt edilemez hâle getirir. Buradaki metin
       kaydın adsız geldiğini söyler, kategorilerin "Sınıflandırılmamış"ı
       bir hesaba yanlışlıkla uymaz. */
    "accounts.untitled": "Adsız hesap",
    "accounts.balance": "Bakiye",
    /* UI.inlineValue labelKey'i aria-label'a çevirir; aria-label altındaki
       yazının yerine geçer, ona eklenmez. Bu yüzden bu iki metin okumanın
       kendisini taşır: taşımazsa denetim yalnız ne olduğunu söyler, okuyucunun
       aradığı sayıyı düşürür. */
    "accounts.name.edit": "Hesap adını değiştir: {name}",
    "accounts.balance.edit": "Bakiyeyi değiştir: {amount}",
    "accounts.opening": "Açılış bakiyesi",
    "accounts.opening.hint": "Kayıtlar bu tutarın üstüne eklenir. Kredi kartı için eksi yazabilirsin.",
    "accounts.total": "Hesap toplamı {amount}",
    /* Kart hangi dönem başlıkta duruyorsa onun hareketini çizer, ille içinde
       bulunduğumuz ay değil. Bir ay adı geçerse Eylül'e geri gidildiğinde
       Eylül'ün hareketi "bu ay" diye yazılır; cümle hiçbir dönemi adıyla
       anmadan her dönem için doğru kalıyor. */
    "accounts.flow": "Bu dönem {in} girdi, {out} çıktı.",
    "accounts.flow.none": "Bu dönem bu hesapta hareket yok.",
    "accounts.kind.cash": "Nakit",
    "accounts.kind.bank": "Banka",
    "accounts.kind.card": "Kredi kartı",
    "accounts.kind.savings": "Birikim",
    "accounts.form.title.new": "Hesap ekle",
    "accounts.form.title.edit": "Hesabı düzenle",
    "accounts.form.submit": "Hesabı ekle",
    "accounts.form.submit.edit": "Hesabı güncelle",
    "accounts.addChip": "Hesap ekle",
    "accounts.archive": "Arşivle",
    "accounts.unarchive": "Arşivden çıkar",
    "accounts.archived": "Arşivde",
    "accounts.delete.title": "Hesap silinsin mi?",
    "accounts.delete.body": "Hesap silinir, kayıtlar kalır. Bu hesaba bağlı kayıtlar defterde durur, yalnız hesap bağlantıları kalkar.",
    "accounts.saved": "Hesap kaydedildi.",
    "accounts.removed": "{name} silindi, {count} kaydın hesap bağlantısı kalktı.",
    "accounts.removed.one": "{name} silindi, {count} kaydın hesap bağlantısı kalktı.",
    "accounts.removed.other": "{name} silindi, {count} kaydın hesap bağlantısı kalktı.",
    "accounts.empty.heading": "Henüz hesap yok.",
    "accounts.empty.body": "Parayı nerede tuttuğunu yaz: nakit, banka, kart, birikim. Bakiyeleri burada toplar, toplam varlığına eklerim.",
    "accounts.empty.action": "İlk hesabı ekle",

    /* ---------------------------------------------------- investments ---- */

    "investments.title": "Yatırımlar",
    "investments.name": "Varlık adı",
    /* Hesaplardaki adsız kaydın yatırım tarafındaki eşi; bir yatırımı hesap
       diye adlandırmamak için kendi metni var. */
    "investments.untitled": "Adsız yatırım",
    "investments.quantity": "Miktar",
    "investments.quantity.hint": "En çok dört ondalık basamak okunur; 0,5 gibi yazabilirsin.",
    "investments.unitCost": "Birim maliyet",
    "investments.unitCost.hint": "Bir birimi kaça aldın.",
    "investments.unitPrice": "Birim fiyat",
    "investments.unitPrice.hint": "Bir birimin bugünkü fiyatı. Fiyatı sen girersin, Moon ağa çıkmaz.",
    "investments.value": "Değer",
    "investments.cost": "Maliyet",
    "investments.gain": "Getiri",
    "investments.gainPct": "%{pct}",
    "investments.gainLine": "Getiri {amount}, %{pct}",
    "investments.qtyLine": "{quantity} × {price}",
    "investments.priceDate": "Fiyat {date} tarihinde güncellendi.",
    "investments.updatePrice": "Fiyatı güncelle",
    "investments.priceSaved": "Yeni fiyat kaydedildi.",
    "investments.byKind": "Türe göre dağılım",
    "investments.byKind.row": "{name}, {amount}, toplamın %{pct} kadarı",
    "investments.chart.none": "Değer izi için en az iki fiyat gerekir. İkinci fiyatı girdiğin an grafik burada çizilir.",
    "investments.kind.stock": "Hisse",
    "investments.kind.fund": "Fon",
    "investments.kind.crypto": "Kripto",
    "investments.kind.gold": "Altın",
    "investments.kind.fx": "Döviz",
    "investments.kind.property": "Gayrimenkul",
    "investments.kind.other": "Diğer",
    "investments.form.title.new": "Yatırım ekle",
    "investments.form.title.edit": "Yatırımı düzenle",
    "investments.form.submit": "Yatırımı ekle",
    "investments.form.submit.edit": "Yatırımı güncelle",
    /* Arşiv eylemleri hesaplardaki kardeşleriyle aynı kelimeleri kullanıyor
       ama kendi anahtarlarını taşıyor: bir dilde yatırım için başka bir fiil
       gerekirse hesap kartlarının metni onunla birlikte değişmesin. */
    "investments.archive": "Arşivle",
    "investments.unarchive": "Arşivden çıkar",
    "investments.archived": "Arşivde",
    "investments.delete.title": "Yatırım silinsin mi?",
    "investments.delete.body": "Yatırım ve fiyat geçmişi silinir. Defterdeki kayıtlara dokunulmaz.",
    "investments.saved": "Yatırım kaydedildi.",
    "investments.removed": "{name} silindi.",
    "investments.empty.heading": "Henüz yatırım yok.",
    "investments.empty.body": "Elindekini yaz: hisse, fon, altın, döviz, ev. Miktarı ve birim fiyatı verirsen değerini ölçer, toplam varlığına eklerim.",
    "investments.empty.action": "İlk yatırımı ekle",

    /* ------------------------------------------------------- networth ---- */

    "networth.rate.why": "{count} para birimi için kur girilmemiş, o yüzden toplamın dışında.",
    "networth.rate.why.one": "Bir para birimi için kur girilmemiş, o yüzden toplamın dışında.",
    "networth.rate.why.other": "{count} para birimi için kur girilmemiş, o yüzden toplamın dışında.",
    "networth.rate.one": "1 {code} kaç {currency}?",
    "networth.rate.set": "Kuru yaz",
    "networth.label": "Toplam varlık",
    "networth.assets": "Varlıklar",
    "networth.liabilities": "Borçlar",
    "networth.cash": "Nakit",
    "networth.investments": "Yatırım",
    "networth.owedToMe": "Alacak",
    "networth.iOwe": "Borç",
    "networth.day": "{dayIndex}/{days} gün",
    "networth.empty": "Toplam varlık henüz ölçülmedi. Bir hesap ya da yatırım yazdığın an burada görünür; ölçülmemiş bir sayıyı sıfır diye yazmıyorum.",

    /* ----------------------------------------------------------- data ---- */

    "data.title": "Veri",

    "data.backup.title": "Yedek al",
    "data.backup.body": "Tüm verin tek bir JSON dosyasına yazılır. Dosya senin bilgisayarında kalır.",
    "data.backup.action": "Yedeği indir",
    "data.backup.done": "{file} indirildi. Tüm verin bu dosyada; başka bir tarayıcıda Veri bölümünden geri yükleyebilirsin.",
    "data.backup.fallback": "Tarayıcı indirmeyi engelledi. Yedeğin metni aşağıda seçili duruyor; kopyalayıp bir dosyaya kaydedebilirsin.",
    "data.backup.copy": "Metni kopyala",
    "data.backup.last": "Son yedek {date}.",
    "data.backup.nudge": "Son yedekten sonra {count} değişiklik oldu. Yedek almak on saniye sürer.",
    "data.backup.nudge.never": "Henüz yedek almadın. Yedek almak on saniye sürer.",

    "data.restore.title": "Geri yükle",
    "data.restore.dropped.one": "Dosyadaki 1 kayıt okunamadı ve alınmadı.",
    "data.restore.dropped.other": "Dosyadaki {count} kayıt okunamadı ve alınmadı.",
    "data.restore.repaired.one": "1 kayıt onarılarak alındı.",
    "data.restore.repaired.other": "{count} kayıt onarılarak alındı.",
    "data.restore.body": "Daha önce indirdiğin JSON dosyasını seç.",
    "data.restore.mode": "Nasıl yüklenecek",
    "data.restore.mode.replace": "Buradaki veriyi değiştir",
    "data.restore.mode.merge": "Buradaki verinin üstüne ekle",
    "data.restore.action": "Dosyayı seç",
    "data.restore.done": "{entries} kayıt ve {categories} kategori geri yüklendi.",
    "data.restore.skipped.one": "{count} kayıt atlandı, aynı kimlik defterde vardı.",
    "data.restore.skipped.other": "{count} kayıt atlandı, aynı kimlik defterde vardı.",
    "data.restore.confirm.title": "Buradaki veri değişecek.",
    "data.restore.confirm.body": "Geri yükleme bu tarayıcıdaki veriyi siler ve dosyadakini yazar. Önce bir yedek al, sonra devam et.",

    "data.sample.title": "Örnek ay",
    "data.sample.body": "Uydurma bir Eylül, 61 kayıt. Önce gezinmek istersen. Tek tuşla temizlenir.",
    "data.sample.on": "Örnek ayı aç",
    "data.sample.off": "Örnek veriyi temizle",
    "data.sample.strip": "Örnek veri açık. Kendi kayıtlarınla karışmaz, tek tuşla temizlenir.",
    "sample.catName": "{name} (örnek)",
    "data.sample.cleared": "Örnek veri temizlendi.",

    "data.wipe.title": "Her şeyi sil",
    "data.wipe.body": "Kayıtlar, limitler, hedefler, borçlar ve ayarlar silinir.",
    "data.wipe.action": "Her şeyi sil",
    "data.wipe.confirm.title": "Her şey silinsin mi?",
    "data.wipe.confirm.body": "Bu tarayıcıdaki tüm Moon verisi silinir ve geri alınamaz. Yedeğini indirdiysen devam edebilirsin.",
    "data.wipe.done": "Tüm veri silindi.",

    "data.settings.title": "Ayarlar",
    "data.settings.currency.hint": "Mevcut tutarlar çevrilmez. 1.000 ₺ kaydı 1.000 $ olarak okunur.",
    "data.settings.monthStartDay": "Dönem başlangıç günü",
    "data.settings.monthStartDay.hint": "Maaşın ayın 15'inde yatıyorsa 15 yaz; dönem o günden başlar.",
    "data.settings.overflowMark": "Aşım işareti",
    "data.settings.overflowMark.pigment": "Pigment",
    "data.settings.overflowMark.flare": "Parlama",
    "data.settings.overflowMark.hint": "Aşımı hangi mürekkebin işaretleyeceğini seçer. Tarama deseni, yüzde ve cümle her durumda kalır.",

    "data.storage.title": "Depolama",
    "data.storage.usage": "{used} kullanıldı, {count} kayıt var.",

    "data.readOnly": "Bu tarayıcıda veri saklanamıyor, oturum salt okunur. Gizli sekme ya da kapatılmış depolama olabilir; yazdıkların sekmeyi kapatınca kaybolur, önce JSON indir.",
    "data.error.corrupt": "Kayıtlı veri okunamadı ve bozuk göründü. Silinmedi, bir kenara alındı; uygulama boş bir defterle açıldı. Elinde yedek varsa Geri yükle bölümünden dönebilirsin.",
    "data.error.newerSchema": "Bu tarayıcıdaki veri daha yeni bir Moon sürümünden. Yanlış okuyup bozmamak için oturum salt okunur açıldı; uygulamayı güncellersen veri yeniden yazılabilir olur.",
    "data.error.unknownSchema": "Kayıtlı verinin sürümü tanınmadı. Dokunulmadı; oturum salt okunur açıldı. Yedeğini indirip Geri yükle ile temiz bir kurulum yapabilirsin.",

    "data.quota.title": "Değişiklik kaydedilemedi.",
    "data.quota.body": "Tarayıcının depolama alanı doldu. Ekrandaki veri duruyor; JSON indirip eski kayıtları silersen yazma yeniden çalışır.",
    "data.quota.action": "JSON indir",

    /* ------------------------------------------------------------ csv ---- */

    "csv.title": "Ekstre yükle",
    "csv.step": "Adım {step}/{total}",
    "csv.back": "Geri",
    "csv.next": "İleri",

    "csv.step1.title": "Dosya",
    "csv.step1.body": "CSV dosyasını buraya sürükle ya da seç. Dosya bu tarayıcıdan çıkmaz.",
    "csv.step1.choose": "Dosya seç",
    "csv.step1.accept": "Kabul edilen: .csv ve .txt",
    "csv.step1.big": "Dosya {size}. Okuma biraz sürebilir; bu sırada sayfa çalışmaya devam eder.",

    "csv.step2.title": "Tanıma",
    "csv.step2.body": "Dosyadan okuduğum ayarlar aşağıda. Yanlış olanı değiştir, önizleme anında yenilenir.",
    "csv.delimiter": "Ayırıcı",
    "csv.delimiter.semicolon": "Noktalı virgül ( ; )",
    "csv.delimiter.comma": "Virgül ( , )",
    "csv.delimiter.tab": "Sekme",
    "csv.delimiter.pipe": "Dikey çizgi ( | )",
    "csv.encoding": "Kodlama",
    "csv.encoding.utf8": "UTF-8",
    "csv.encoding.w1254": "Windows-1254 (Türkçe)",
    "csv.encoding.utf16le": "UTF-16LE",
    "csv.headerRow": "Başlık satırı",
    "csv.headerRow.hint": "Ekstrenin başındaki serbest metin atlanır.",
    "csv.decimal": "Ondalık ayracı",
    "csv.decimal.comma": "Virgül ( 1.234,56 )",
    "csv.decimal.dot": "Nokta ( 1,234.56 )",
    "csv.dateOrder": "Tarih sırası",
    "csv.dateOrder.dmy": "Gün, ay, yıl",
    "csv.dateOrder.mdy": "Ay, gün, yıl",
    "csv.dateSample": "Dosyada {raw} yazıyor, {parsed} olarak okudum.",
    "csv.preview": "İlk {count} satır",
    "csv.role": "Sütun rolü",
    "csv.column": "{index}. sütun",
    "csv.role.ignore": "Yoksay",
    "csv.role.date": "Tarih",
    "csv.role.note": "Açıklama",
    "csv.role.amount": "Tutar",
    "csv.role.debit": "Borç",
    "csv.role.credit": "Alacak",
    "csv.role.category": "Kategori",
    "csv.role.confidence": "%{pct} okunabildi",

    /* The import no longer stops to ask which column holds the date: the roles
       are inferred from the data and the preview opens straight away. These
       keys are the words that step needs — one line of account for the guess,
       the control that reopens the mapping step when the guess is wrong, and
       the count of page lines that were never transactions. The last one is
       kept deliberately flat: an interest-rate table left out of an import is
       a fact about the statement, not a fault of the reader's, so it must not
       read like a warning. */
    "csv.roles.guessed": "Sütunları kendim çıkardım ve {count} satır okudum. Yanlış tuttuğum bir sütun varsa düzeltebilirsin.",
    "csv.roles.fix": "Sütunları düzelt",
    "csv.rows.skipped.one": "Sayfadaki {count} satır işlem değil — faiz tablosu, toplam, adres gibi — dışarıda kaldı.",
    "csv.rows.skipped.other": "Sayfadaki {count} satır işlem değil — faiz tablosu, toplam, adres gibi — dışarıda kaldı.",

    "csv.signRule": "İşaret kuralı",
    "csv.signRule.negativeIsExpense": "Eksi olanlar gider",
    "csv.signRule.positiveIsExpense": "Artı olanlar gider (kredi kartı)",
    "csv.signRule.debitCredit": "Borç ve alacak ayrı sütunda",
    "csv.defaultCategory": "Varsayılan kategori",
    "csv.defaultCategory.hint": "Kategorisi okunamayan satırlar buraya yazılır.",

    "csv.step3.title": "İnceleme",
    "csv.step3.summary": "{total} satır okundu. {ok} tanesi eklenebilir, {duplicate} tanesi mükerrer, {rejected} tanesi atlandı.",
    "csv.step3.range": "Tarihler {from} ile {to} arasında.",
    "csv.step3.sums": "Gider {out}, gelir {in}.",
    "csv.duplicates.title": "Mükerrer satırlar",
    "csv.duplicates.body": "Bu satırların aynısı defterde duruyor. İşaretli olanlar atlanır; aynı gün aynı tutarda iki gerçek harcama varsa işareti kaldır.",
    "csv.duplicates.row": "Satır {line}: {date}, {amount}",
    "csv.skipped.title": "Atlanan satırlar",
    "csv.skipped.body": "Bu satırlardan kayıt üretilemedi.",
    "csv.skipped.row": "Satır {line}: {reason}",
    "csv.reason.badDate": "tarih okunamadı",
    "csv.reason.badAmount": "tutar okunamadı",
    "csv.reason.zeroAmount": "tutar sıfır",
    "csv.reason.raggedRow": "alan sayısı başlığa uymuyor",
    "csv.reason.unclosedQuote": "tırnak kapanmamış",
    "csv.reason.repeatedHeader": "tekrar eden başlık satırı",
    "csv.reason.summaryRow": "özet satırı",

    "csv.step4.title": "Yazma",
    "csv.step4.action": "Kayıtları yaz",
    "csv.done.one": "{count} kayıt eklendi, onay bekliyor.",
    "csv.done.other": "{count} kayıt eklendi, onay bekliyor.",
    "csv.done.body": "Defterde kenar işaretiyle görünüyorlar. Tümünü onayla düğmesi Defter bölümünde duruyor.",

    "csv.err.noDate": "Bu dosyada tarih sütununu bulamadım. Hangi sütunun tarih olduğunu sen gösterirsen devam ederim.",
    "csv.err.noAmount": "Bu dosyada tutar sütununu bulamadım. Tutarı taşıyan sütunu seçersen devam ederim.",
    "csv.err.empty": "Bu dosyada okunacak satır yok. Boş olabilir ya da başka bir sekmesi kaydedilmiş olabilir; CSV olarak kaydedip tekrar dene.",
    "csv.err.notCsv": "Bu dosyayı CSV olarak okuyamadım. Uzantısı .csv ya da .txt olan bir dosya seç.",
    "pdf.err.notPdf": "Bu dosya PDF gibi okunmadı. Bankanın verdiği özgün dosyayı seç; yeniden kaydedilmiş ya da yarım inmiş olabilir.",
    "pdf.err.encrypted": "Bu PDF parolalı. Parolayı bilen bir programda açıp parolasız olarak kaydet, sonra tekrar dene.",
    "pdf.err.noText": "Bu PDF'in içinde metin yok, yalnızca sayfanın görüntüsü var — taranmış ya da fotoğraflanmış bir ekstre böyle gelir. Bankanın sitesinden CSV ya da metin içeren PDF indirebilirsen onu okuyabilirim.",
    /* Separate from pdf.err.noText because the cause and the cure are both
       different: such a page does carry a little text — a title, a card line —
       so the file never looks empty, and it usually came out of a phone
       banking app that draws the statement as a picture. Naming web banking
       and CSV gives the reader somewhere to go in one step. The word "hata"
       stays out of it, because nothing they did was wrong. */
    "pdf.err.scanned": "Bu PDF'in sayfası bir resim: içinde okunacak metin yok denecek kadar az. Telefondaki bankacılık uygulamasından indirilen ekstre ya da taranmış bir kâğıt genelde böyle gelir. Aynı ekstre bankanın internet şubesinde çoğu zaman CSV ya da metin içeren PDF olarak da duruyor; ikisini de okuyabilirim.",
    "pdf.warn.fewRows": "Bu PDF'ten yalnızca birkaç satır çıkarabildim. Aşağıdaki önizleme eksikse bankanın CSV dosyası daha güvenilir olur.",
    "pdf.reading": "PDF okunuyor…",
    "pdf.read.summary": "{pages} sayfadan {lines} satır okundu.",
    /* A statement is read twice over — once off the page's column grid, once
       line by line looking for a date next to an amount — and the better of
       the two wins. The small print under the preview says which one won,
       because that is the first thing worth knowing when a column looks
       wrong, and the reader has no console to ask. */
    "pdf.read.table": "Sütunlar sayfadaki hizalardan çıkarıldı.",
    "pdf.read.lines": "Her satırda tarih ve tutar arandı.",
    "pdf.note": "PDF'teki sütunlar yazıların yerinden çıkarılır, ayraçtan değil. Yazmadan önce aşağıdaki satırlara bir bak.",
    "csv.step1.acceptPdf": "Kabul edilen: .csv, .txt ve .pdf",
    "csv.err.encodingGuess": "Türkçe harfler bozuk görünüyor, kodlamayı tahminle seçtim. Yanlışsa kodlamayı elle değiştir.",
    "csv.err.ambiguousDecimal": "{sample} değeri iki türlü okunabilir. Ondalık ayracını sen seçersen tutarı doğru yazarım.",
    "csv.err.noNegative": "Bu sütunda hiç eksi değer yok: satırların hepsi gelir olarak yazılacak. Yönü taşıyan bir sütun varsa rolünü seç, yoksa sırayı sonra defterden düzeltebilirsin.",
    "csv.err.ambiguousDate": "Gün ve ay sırası bu dosyadan anlaşılmıyor. Sırayı seçersen tarihleri doğru yazarım.",
    "csv.err.readFailed": "Dosya okunamadı. Tarayıcı erişimi engellemiş olabilir; dosyayı başka bir klasöre kopyalayıp tekrar dene.",
    "csv.err.tooBig": "Dosya {size} ve tarayıcının depolama alanını doldurabilir. Önce yedek al, sonra devam et.",
    "csv.err.tooManyRows": "Bu dosyada çok fazla satır var, elli binden sonrası okunmuyor. Ekstreyi aylara bölüp ayrı ayrı yükleyebilirsin.",

    /* ----------------------------------------------------------- form ---- */

    "quick.keepGoing": "Arka arkaya",
    "quick.account": "Hangi hesaptan",
    "a11y.plus": "Ekle",
    "a11y.minus": "Çıkar",
    "a11y.equals": "Sonucu bul",
    "quick.open": "Harcama ekle",
    "quick.title": "Yeni harcama",
    "quick.title.income": "Yeni gelir",
    "quick.kind.out": "Gider",
    "quick.kind.in": "Gelir",
    "quick.pickDate": "Başka gün",
    "quick.note": "Not ekle",
    "quick.chooseCategory": "Kategori seç",
    "quick.recent": "Son kullandıkların",
    "quick.all": "Tümü",
    "quick.saved": "{amount} {category} olarak yazıldı.",
    "quick.empty": "Önce bir kategori gerekiyor. Limitler bölümünden bir tane ekle, sonra buraya dön.",
    "quick.hint": "Tutarı yaz, kategoriye dokun. Dokunduğun an kaydedilir.",
    "a11y.keypad": "Sayı tuşları",
    "a11y.backspace": "Son basamağı sil",
    "a11y.amountNow": "Girilen tutar: {amount}",
    "form.date": "Tarih",
    "form.amount": "Tutar",
    "form.amount.hint": "Virgül ya da nokta kullanabilirsin.",
    "form.amount.preview": "Okunan tutar {amount}",
    "form.direction": "Yön",
    "form.direction.out": "Gider",
    "form.direction.in": "Gelir",
    "form.category": "Kategori",
    "form.note": "Açıklama",
    "form.note.hint": "En çok {max} karakter.",
    "form.fixed": "Sabit ödeme",
    "form.name": "Ad",
    "form.kind": "Tür",
    /* Renk seçicinin radio grubunun ve simge seçicinin katlanma düğmesinin
       adı. İkisi de üstlerinde yazı taşımıyor — biri on nokta, öteki tek bir
       glif — bu yüzden adı yalnız buradan geliyor. */
    "form.color": "Renk",
    "form.icon": "Simge",
    "form.startDate": "Başlangıç",
    "form.endDate": "Bitiş",
    "form.endDate.hint": "Boş bırakırsan süresiz.",
    "form.dueDate": "Vade",
    "form.limit": "Limit",
    "form.required": "zorunlu",
    "form.optional": "isteğe bağlı",
    "form.errors.title": "Form kaydedilmedi.",
    "form.errors.body.one": "{count} alan düzeltilmeli.",
    "form.errors.body.other": "{count} alan düzeltilmeli.",

    /* ------------------------------------------------------------ err ---- */

    "err.required": "Bu alan boş. Kayıt yazmak için doldurulması gerekiyor.",
    "err.badDate": "Tarih okunamadı. Beklenen biçim yıl-ay-gün; takvimden bir gün de seçebilirsin.",
    "err.badAmount": "Tutar okunamadı. Rakam, virgül ya da nokta kullan; harf ve boşluk okunmuyor.",
    "err.zeroAmount": "Tutar sıfır. Sıfırlık kayıt ölçülemez; gerçek tutarı yaz.",
    "err.negativeAmount": "Tutar eksi yazılmış. Yön Gider ve Gelir alanından seçilir, tutar artı kalır.",
    "err.quantityInvalid": "Miktar okunamadı. En çok dört ondalık basamak okunur; 0,5 ya da 12,3456 gibi yaz.",
    "err.quantityPrecision": "Miktarda dört ondalık basamaktan fazlası var. Fazlası yuvarlanıp sessizce kaybolmasın diye kabul edilmiyor; dört basamağa kısaltıp yaz.",
    "err.quantityNegative": "Miktar eksi yazılmış. Elinde ne kadar varsa artı olarak yazılır; sattığın kadarını düşmek için miktarı küçült.",
    "err.priceRequired": "Birim fiyat boş. Fiyat olmadan değer ölçülemez; bir birimin bugünkü fiyatını yaz.",
    "err.tooLong": "Metin çok uzun. En çok {max} karakter saklanıyor; kısaltıp tekrar dene.",
    "err.noteTooLong": "Açıklama çok uzun. En çok 200 karakter saklanıyor; kısaltıp tekrar dene.",
    "form.dateHint": "Gün, ay, yıl. Takvimden de seçebilirsin.",
    "err.badCategory": "Bu kategori artık yok. Listeden var olan bir kategori seç.",
    "err.badDirection": "Yön kategoriyle uyuşmuyor. Gelir kategorisine gider yazılamaz; kategoriyi ya da yönü değiştir.",
    "err.badDayOfMonth": "Ayın günü 1 ile 31 arasında olmalı. Kısa aylarda son güne kırpılır.",
    "err.badMonthStartDay": "Dönem başlangıç günü 1 ile 28 arasında olmalı. Kısa aylarda dönem kaymasın diye üst sınır 28.",
    "err.badRange": "Bitiş tarihi başlangıçtan önce. Tarihlerden birini düzelt.",
    "err.badTarget": "Hedef tutar sıfır ya da eksi. Ulaşmak istediğin tutarı yaz.",
    "err.limitOnIncome": "Limit yalnız gider kategorisine konur. Gelir kategorisinin kısılacak harcaması yok; buraya yazılan limit hiçbir yerde okunmaz.",
    "err.quotaFull": "Değişiklik kaydedilemedi, tarayıcının depolama alanı dolu. Ekrandaki veri duruyor; JSON indirip eski kayıtları silersen yazma yeniden çalışır.",
    "err.writeFailed": "Değişiklik kaydedilemedi. Tarayıcı yazmayı reddetti; sekmeyi kapatmadan yedeğini indir.",
    "err.readOnly": "Bu tarayıcıda veri saklanamıyor. Gizli sekme ya da kapatılmış depolama olabilir; yazdıkların yalnız bu oturumda durur, JSON indirip taşıyabilirsin.",
    "err.importBadFile": "Bu dosya Moon yedeği gibi okunmadı. Beklenen alanlar içinde yok; Veri bölümünden indirdiğin JSON dosyasını seç.",
    "err.importNewer": "Bu yedek daha yeni bir Moon sürümünden. Bu sürüm dosyayı okuyamıyor; uygulamayı güncelleyip tekrar dene.",
    "err.readFailed": "Dosya okunamadı. Tarayıcı dosyaya erişemedi; başka bir klasöre kopyalayıp tekrar seç.",
    "err.unknown": "Beklenmeyen bir şey oldu ve işlem tamamlanmadı. Sayfayı yenile; kayıtlı verin yerinde kalır.",
    "money.invalid": "Tutar okunamadı. Rakam, virgül ya da nokta kullan; harf ve boşluk okunmuyor.",

    /* ---------------------------------------------------------- empty ---- */

    "empty.panel.heading": "Ölçülecek bir şey yok.",
    "empty.panel.body": "İlk kaydı yazdığın an bu şerit dolar.",
    "empty.ledger.heading": "Defter henüz boş.",
    "empty.ledger.body": "Moon hiçbir veriyi bir sunucuya göndermez. Ne yazarsan bu tarayıcıda kalır, istediğin an JSON olarak indirip başka bir cihaza taşıyabilirsin. Başlamak için üç yol var:",
    "empty.ledger.action1": "Bir harcama yaz — 10 saniye sürer.",
    "empty.ledger.action2": "Banka ekstreni yükle — CSV dosyasını buraya sürükle, sütunları birlikte eşleştiririz.",
    "empty.ledger.action3": "Örnek ayı aç — uydurma bir Eylül, 61 kayıt. Önce gezinmek istersen. Tek tuşla temizlenir.",
    "empty.ledger.footer": "Örnek veri açıkken üstte bir şerit durur; kendi verinle karışmaz.",
    "empty.ledger.filtered.heading": "Bu filtreye uyan kayıt yok.",
    "empty.ledger.filtered.body": "Aramayı kısalt ya da dönemi genişlet.",
    "empty.limits.heading": "Limit yok.",
    "empty.limits.body": "Limit koymadan da kayıt tutabilirsin. Limit koyduğun an bu satırlar ölçeğe dönüşür.",
    "empty.recurring.heading": "Tekrarlayan ödeme yok.",
    "empty.recurring.body": "Kira, abonelik, fatura gibi her dönem dönen ödemeleri bir kez yaz; her dönem onayına düşer.",
    "empty.goals.heading": "Hedef yok.",
    "empty.goals.body": "Bir hedef yaz: ne kadar ve ne zaman. Gerisini aydan aya ben ölçerim.",
    "empty.debts.heading": "Borç ve alacak yok.",
    "empty.debts.body": "Kime ne kadar verdin, kimden ne kadar alacaksın. Bu kayıtlar günlük pay hesabına girmez.",
    "empty.chart.heading": "Grafik için veri yetmiyor.",
    "empty.chart.body": "Grafik için en az yedi günlük kayıt gerekir. Şu an {days} gün var.",
    "empty.data.heading": "Yedeklenecek veri yok.",
    "empty.data.body": "İlk kaydı yazdığın an yedek alınabilir olur.",

    /* ------------------------------------------------------------ cat ---- */

    "cat.rent": "Kira",
    "cat.bills": "Faturalar",
    "cat.subscriptions": "Abonelikler",
    "cat.groceries": "Market",
    "cat.eatingOut": "Dışarıda yemek",
    "cat.transport": "Ulaşım",
    "cat.health": "Sağlık",
    "cat.home": "Ev",
    "cat.clothing": "Giyim",
    "cat.fun": "Eğlence",
    "cat.other": "Diğer",
    "cat.salary": "Maaş",
    "cat.otherIncome": "Diğer gelir",

    /* ----------------------------------------------------------- a11y ---- */

    "a11y.skip": "İçeriğe geç",
    "a11y.rail": "Bölümler",
    "a11y.railMore": "Diğer bölümler",
    "a11y.strip": "Duyurular ve geri alma",
    "a11y.accounts": "Hesaplar ve bakiyeleri",
    "a11y.periodPrev": "Önceki dönem",
    "a11y.periodNext": "Sonraki dönem",
    "a11y.periodCurrent": "Gösterilen dönem {period}",
    "a11y.disc": "Dönemin geçen kısmı %{pct}",
    "a11y.rowActions": "Satır eylemleri",
    "a11y.showTable": "Bu grafiğin sayılarını tablo olarak göster",
    "a11y.markOver": "limit aşıldı",
    "a11y.markRecurring": "tekrarlayan ödemeden geldi",
    "a11y.markUnconfirmed": "ekstreden geldi, onay bekliyor",
    "a11y.chart.trail.desc": "Dönemin her günü için ölçülen günlük pay. En düşük {min}, en yüksek {max}, dönem başındaki pay {reference}.",
    "a11y.chart.flow.desc": "Dönemin her günü için tek çubuk. Toplam gelir {in}, toplam gider {out}.",
    "a11y.chart.cumulative.desc": "Dönem başından bugüne toplam gider {total}, aynı güne düşen hız değeri {pace}.",
    "a11y.chart.year.desc": "Son on iki dönem ve {rows} kategori. Yoğunluk çizgi sıklığıyla verilir.",
    /* Değer izinin kendi <desc> metni. Bir değer grafiğinin cevapladığı soru
       "şimdi ne kadar" olduğu için en yeni okumayı söylüyor. */
    "a11y.chart.value.desc": "Yatırımlarının zaman içindeki değeri. En yeni okuma {date} günü {amount}.",
    "a11y.chart.point": "{date}, {amount}",
    "a11y.chart.pointPct": "{name}, {amount}, toplamın %{pct} kadarı",
    "a11y.langChanged": "Dil {lang} olarak değişti.",
    "a11y.routeChanged": "{section} bölümü açıldı."
  };
})(window);
