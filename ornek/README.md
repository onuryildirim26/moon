# Örnek ekstreler / Sample statements

**TR —** Buradaki dosyaların hepsi uydurmadır. Banka adları, kart numarası,
üye iş yerleri ve tutarlar hiçbir gerçek hesaptan alınmamıştır; her birinin
altında "bu belge yazılım denemesi için üretilmiş bir örnektir" satırı vardır.
Moon'u denemek için bunları sürükleyip bırakabilirsiniz.

**EN —** Everything here is invented. The banks, the card number, the merchants
and the amounts came from nobody's real account, and each document carries a
line saying it is a sample produced for testing software. Drop any of them on
Moon to try the importer.

---

## `ornek-ekstre-tr.csv`

**TR —** Türk bankalarının verdiği klasik CSV: noktalı virgül ayracı, gün.ay.yıl
tarihler, virgüllü ondalık, tutar ve yürüyen bakiye. 25 satır.

**EN —** The CSV a Turkish bank hands out: semicolon separated, dd.mm.yyyy
dates, comma decimals, an amount column and a running balance. 25 rows.

## `sample-statement-en.csv`

**TR —** İngilizce karşılığı: virgül ayracı, yıl-ay-gün tarihler, noktalı
ondalık, borç ve alacak ayrı sütunlarda. 24 satır.

**EN —** The English counterpart: comma separated, yyyy-mm-dd dates, dot
decimals, separate debit and credit columns. 24 rows.

## `ornek-ekstre-tr.pdf`

**TR —** Yazdırılmış bir vadesiz hesap ekstresi. Gerçek bir bankanın dosyası
gibi, alt kümeye indirilmiş font ve glif numarası kodlamasıyla. PDF okuyucunun
en eski örneği; davranışı değişmemelidir.

**EN —** A printed current-account statement, with the subset font and the
glyph-number encoding a bank's own file arrives in. The PDF reader's oldest
sample; its behaviour must not change.

## `ornek-kredi-karti-tr.pdf`

**TR —** Kredi kartı hesap özeti. Bu dosya *bilerek zor*: sayfanın başında
ayrı bir faiz oranı tablosu var, işlem tablosunun başlığı üç satıra sarıyor,
sütunlar birbirine yakın, altta da toplamlar ve yasal dipnot var. Tarihler
gg/aa/yyyy, ondalık ayracı nokta. 15 işlem satırı, ikisinden sonra taksit
notu geliyor.

Dosyanın varlık sebebi şudur: okuyucu bir harfin genişliğini tahmin ettiği
sürece tarih, açıklama ve tutar tek bir hücrede birleşir, tarih sütunu
bulunamaz ve sihirbaz kullanıcıya soru sorar. Font genişlikleri dosyadan
okunduğunda dört sütun da ayrı gelir.

**EN —** A credit-card statement, and it is *deliberately hard*: an interest-rate
table sits above the transactions, the transaction header wraps over three
lines, the columns are tight, and totals and a legal footer sit below. Dates are
dd/mm/yyyy and the decimal separator is a dot. Fifteen transaction rows, two of
them followed by an instalment note.

The file exists to catch one thing: as long as the reader *guesses* how wide a
character is, the date, the description and the amount merge into a single cell,
no column parses as a date, and the wizard asks the reader a question. Once the
real glyph widths are read out of the file, all four columns come apart.

## `ornek-hesap-ekstresi-tr.pdf`

**TR —** Vadesiz hesap ekstresi: hesap bilgileri önsözü, sonra tarih, açıklama,
tutar ve yürüyen bakiye. Tarihler gg.aa.yyyy, ondalık ayracı virgül. 12 satır,
ikisi gelir. Bu dosya kontrol örneğidir — bugün de doğru okunur, yarın da
doğru okunmalıdır.

**EN —** A current-account statement: a preamble of account details, then date,
description, amount and running balance. Dates are dd.mm.yyyy and the decimal
separator is a comma. Twelve rows, two of them income. This one is the control:
it reads correctly today and must keep reading correctly.

---

## TR — Bu dosyalar nasıl üretildi

İkisi de HTML'den, başı boş bir Edge ile yazdırıldı:

```
& 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' `
    --headless=new --disable-gpu --no-pdf-header-footer `
    --print-to-pdf=ornek-kredi-karti-tr.pdf file:///.../kredi-karti.html
```

Bir ayrıntı önemlidir: punto boyutu, Chromium'un metni nasıl yazdığını
belirler. Tam sayı piksel boyutunda (kredi kartı örneği, 12px) her hücre tek
bir `Tj` olarak çıkar; kesirli boyutta (hesap ekstresi, 10pt = 13,33px) her
glif ayrı konumlandırılır. Birleşme hatası yalnız birincisinde görülür.

## EN — How these were produced

Both were printed from HTML through headless Edge, with the command above.

One detail matters: the type size decides how Chromium writes the text. At an
integral pixel size (the credit-card sample, 12px) each cell comes out as a
single `Tj`; at a fractional size (the account statement, 10pt = 13.33px) every
glyph is positioned on its own. The merging failure only appears in the first.
