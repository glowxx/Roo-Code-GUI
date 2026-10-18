# Roo Code — polski interfejs desktopowy

Przebudowa obejmuje okno Electron i osadzony interfejs React. Wspólny plik `apps/desktop/src/renderer/design-tokens.css` określa kolory, typografię i podstawowe style motywów. `workspace.css` w każdej z warstw odpowiada za układ i komponenty tej warstwy.

## Zmiany

- Neutralna grafitowa paleta, spokojniejsza nawigacja, czytelniejszy panel projektów i rozmów.
- Główny widok jako rozmowa: wypowiedzi agenta i wyniki na pierwszym planie, zbiorcze szczegóły operacji zwinięte domyślnie.
- Nowy ekran startowy z podpowiedziami, które uzupełniają pole wiadomości; wysyłanie nadal wymaga działania użytkownika.
- Większy edytor wiadomości; kontrolki modelu i narzędzi zawijają się na węższych oknach.
- Spójne formularze, menu, przyciski, podglądy i ustawienia w pięciu zachowanych motywach.
- Systemowe czcionki Windows, dostępne bez połączenia z internetem; obsługa ograniczania animacji i widoczny fokus klawiatury.
- Polski jako język startowy, także przy pierwszym uruchomieniu tej edycji na istniejącej konfiguracji. Nazwy modeli, dostawców i technologii zachowano.
- Uzupełnione zasoby tłumaczeń oraz teksty wpisane bezpośrednio w komponentach i natywnych menu.
- Ustawienia korzystają z bufora `cachedState`. Podgląd motywu synchronizuje okno i oba osadzone widoki, a odrzucenie zmian przywraca wygląd wynikający z bufora.
- Automatyczny komunikat o zakończeniu rozwoju oryginalnego rozszerzenia nie zasłania startu samodzielnej aplikacji.

## Budowanie

W katalogu głównym repozytorium:

```powershell
pnpm install --frozen-lockfile
pnpm --filter @roo-code/build build
pnpm --filter @roo-code/types build
pnpm --filter @roo-code/desktop package:win
```

Instalator trafia do `apps/desktop/release/`. Zawiera Electron, silnik agenta, interfejs i ripgrep. Użytkownik końcowy nie potrzebuje Node.js, pnpm ani VS Code.

Wersję bez instalacji można przygotować z tego samego buildu:

```powershell
pnpm --filter @roo-code/desktop exec electron-builder --prepackaged release/win-unpacked --win portable --x64
```

W konfiguracji pnpm zawężono nadpisanie `brace-expansion` do starych wersji. Wymuszanie wersji 2 dla nowego `minimatch` blokowało pakowanie. Instalator startuje po polsku; angielskie zasoby dołączono na potrzeby zgodności kompilatora NSIS, bez wyświetlania wyboru języka.

## Weryfikacja

```powershell
node scripts/audit-polish.mjs
pnpm --filter @roo-code/desktop check-types
pnpm --filter @roo-code/desktop test
```

Audyt sprawdza kompletność 1819 kluczy zasobów polskich w interfejsie i silniku oraz zgodność parametrów interpolacji. Nazwy własne i treści pochodzące od użytkownika, modelu, API lub terminala nie są automatycznie tłumaczone.

`scripts/launch-design-preview.mjs` uruchamia aplikację na porcie 5993 z osobnymi danymi w `.design-qa/`. Opcja `--packaged` wybiera plik z `release/win-unpacked`. `scripts/test-design-runtime.mjs` sprawdza za pomocą protokołu testowego Electron ekran startowy, podpowiedzi, pliki, widoki zmian i terminala, czat, motywy oraz węższy układ. Zapisuje wyniki i zrzuty w `.design-qa/`.

Opcja `--portable` uruchamia gotowy plik `Roo-Code-PL-Portable-1.0.0-x64.exe`. Aktualna weryfikacja obejmuje 199 testów desktopowych, 195 wybranych testów UI i 5 testów wskazówek komunikacji agenta. Kompilacja produkcyjna obejmuje kontrolę typów interfejsu.

Testy interfejsu nie wysyłają płatnych zapytań do zewnętrznych modeli. Rozmowy z wybranym dostawcą wymagają skonfigurowania jego klucza API, tak jak przed przebudową.

Build jest lokalny i nie ma podpisu cyfrowego wydawcy.

## Domknięcie warstwy wizualnej

Wspólne tokeny określają teraz także promienie kontrolek i paneli, cienie, czas przejść oraz semantyczne kolory ostrzeżeń i błędów. Usunięto drugi, odziedziczony zestaw pięciu palet z `webview-ui/src/index.css`, który potrafił przywracać stare kolory po zmianie motywu. Widoki Electron i React korzystają z tego samego źródła kolorów.

`ui-surfaces.css` ujednolica komponenty menu, list wyboru, formularzy, dialogów, podpowiedzi i przełączników. Dolny pasek używa wspólnej wysokości, typografii i neutralnych ikon; stan otwartego panelu, aktywnego ustawienia oraz fokus klawiatury mają osobne oznaczenia. Panel rozumowania, zatwierdzania, trybów i worktree korzysta z tej samej warstwy powierzchni. Wskaźnik kontekstu jest neutralny przy zwykłym użyciu i zachowuje wcześniejsze progi ostrzegawcze oraz obliczenia.

Ujednolicono też ustawienia bezpieczeństwa, podglądy motywów, awatary i rozumowanie w czacie, checkpointy, menu kontekstowe oraz stany plików i terminala. Usunięto ozdobne gradienty, pulsujące obwódki i powiększanie kontrolek; animacje ładowania i semantyczne kolory statusów pozostają. Ograniczenie ruchu respektuje ustawienie systemowe. Obsługa i zapis ustawień, w tym bufor `cachedState`, pozostają bez zmian.

`node scripts/audit-interface-runtime.mjs` oraz wariant `--light` zapisują przegląd trzech paneli dolnego paska, trybu automatycznego zatwierdzania, siedmiu kategorii ustawień, pięciu widoków desktopowych i przykładowej rozmowy. Rozmowa jest wyłącznie lokalną próbką wizualną: nie zapisuje się jej i nie wysyła do modelu. Raporty i zrzuty trafiają do `.design-qa/`. Kontrolę uzupełniają skrypty `test-design-runtime.mjs` i `test-model-selector-runtime.mjs` oraz 133 testy UI, stanu konfiguracji, przełączników i obliczeń kontekstu.

## Panel modeli

Panel używa jednej listy z wierszami o wysokości co najmniej 64 px. Nazwa i subtelne oznaczenie możliwości są oddzielone od dostawcy i wyrównanego kontekstu. Każdy model występuje raz, we właściwej rodzinie. Wyszukiwarka otrzymuje fokus przy otwarciu; strzałki, Home i End przechodzą między widocznymi modelami, Enter wybiera, a Escape zamyka panel. Filtry uwzględniają modele mające kilka możliwości jednocześnie.

Lista jest podzielona wyłącznie na rodziny GPT, Claude, Gemini, Qwen, Grok, Llama (Meta), DeepSeek i inne. Nagłówki zawierają firmę, lokalny monochromatyczny znak lub monogram i liczbę modeli. Grupy startują zwinięte; wyszukiwanie i filtry rozwijają wyniki. Dawne sekcje ostatnich i polecanych modeli usunięto, a ich modele włączono do rodzin. Ręcznie dodane modele zapisane w historii również pozostają dostępne w rodzinach bieżącego dostawcy. Klawiatura pomija ukryte wiersze.

Sortowanie porównuje osobno liczby w generacji (np. 5.10 i 5.9), potem wariant modelu i identyfikator. Zwykły model pojawia się przed jego wariantem `:batch`; sufiksy `:batch`, `:free` itd. są widoczne przy nazwie. Wybrany model otrzymuje podpis, znacznik i subtelny kolor akcentu. Dostawca API, główna możliwość i kontekst mają stałe miejsca w drugim wierszu.

`node scripts/test-model-selector-runtime.mjs` sprawdza panel w działającej aplikacji: wybór klawiaturą, zapis aktywnego i ostatnio używanego modelu, wyszukiwanie, filtry, grupy i zwijanie, oba motywy i okno 900 px. Zapisuje zrzuty oraz `.design-qa/model-picker-results.json`. Dodatkowo 53 testy jednostkowe selektora i blokady konfiguracji sprawdzają zachowanie wyboru, rozumowania, deduplikacji, historii, klasyfikacji rodzin i sortowania modeli.

## Rozmowa zamiast dziennika operacji

Główny widok agenta zachowuje tekst rozmowy, pytania i rezultat zadania. Kolejne odczyty plików, komendy, output terminala, rozumowanie, checkpointy oraz metadane API łączy w zbiorcze „Szczegóły pracy”, domyślnie zwinięte. Bieżący stan jest jedną neutralną linią opisującą zaobserwowaną operację; interfejs nie dopisuje własnych ustaleń ani nie uznaje testów za zaliczone na podstawie samego uruchomienia komendy.

Instrukcje agenta proszą o zwięzłe, naturalne aktualizacje przy istotnych ustaleniach, rozpoczęciu poprawek, weryfikacji i przeszkodach. Nie żądają relacjonowania każdej operacji. Faktyczne brzmienie aktualizacji zależy od odpowiedzi wybranego modelu; nie powstają dodatkowe zapytania do modelu streszczającego log.

Otwarte prośby o zgodę, pytania i nierozwiązane błędy pozostają widoczne. Komenda lub zakres operacji potrzebny do podjęcia decyzji nie jest ukrywany. Szczegóły diagnostyczne można rozwinąć, a reguły zatwierdzania i ograniczenia bezpieczeństwa nie zmieniają się. Strumień aktywnego terminala jest nadal odbierany przy zwiniętym logu. Skoki do checkpointów otwierają właściwą grupę i zachowują wszystkie checkpointy z oryginalnej historii.

Nagłówek pokazuje krótki opis zadania; zużycie tokenów i dodatkowe działania są dostępne po rozwinięciu. Plan ma kompaktowy wiersz i rozwijaną pełną listę. Wiadomości nie powtarzają etykiet autora, kolorowych obramowań ani odrębnych alertów dla każdego kroku. Neutralne style obejmują także pytania, podsumowanie, wyniki podzadań i limity żądań.

`node scripts/test-agent-conversation-runtime.mjs` oraz wariant `--light` sprawdzają rzeczywisty komponent widoku agenta z lokalną próbką historii: zwijanie klawiaturą, zachowanie zdarzeń terminala, widoczną komendę wymagającą zgody, przycisk zatwierdzania, odpowiedzi na pytania, diagnostykę błędu, zakończenie i układ 900 px. Próbka nie jest zapisywana; działania wychodzące są przechwytywane, więc test nie uruchamia komend ani płatnych zapytań. Zrzuty `conversation-*.png` i raporty trafiają do `.design-qa/`.
