# Audyt aplikacji desktopowej

Punkt odniesienia: organizacja pracy wokół projektów i rozmów, spokojna komunikacja, szczegóły na żądanie oraz przewidywalne działania znane z Codexa. Audyt obejmuje okno Electron, widok agenta, czat, pliki, zmiany, terminal, konfigurację i stany puste.

## Braki funkcjonalne i UX

| Obszar | Zastany problem | Docelowe zachowanie |
| --- | --- | --- |
| Projekty | Zmiana folderu wymaga znajomości menu; brak edytowalnej ścieżki i wskazania przeniesionego projektu | Stały wybór projektu, menedżer lokalizacji, otwieranie po ścieżce i wybór systemowy |
| Zmiana projektu | Rozmowa jest czyszczona przed potwierdzeniem prawidłowości ścieżki; błędy przechodzą w cichy fallback | Walidacja, widoczny błąd, zachowanie rozmowy przy niepowodzeniu |
| Lokalizacja | Tożsamość projektu jest jego ścieżką; brak zmiany przypisania po przeniesieniu katalogu | Wskazanie istniejącego folderu z zachowaniem historii; zakaz zmiany podczas aktywnej pracy |
| Sidebar | Brak wyszukiwania projektów/rozmów i głównej akcji nowej rozmowy | Szybkie wyszukiwanie i stała akcja, pełna ścieżka na żądanie |
| Kontekst | Niewidoczne dla nowych osób `@`, brak zwykłego przycisku wyboru wielu plików i usuwania kontekstu | Jawny przycisk, wyszukiwarka, lista zaznaczeń, usuwanie bez przepisywania wiadomości |
| Pliki | Podgląd bez bezpośredniego dodania do rozmowy; brak edycji tekstu | Otwieranie i wyszukiwanie, dodanie kontekstu, edytor z zapisem i wykryciem zmiany na dysku |
| Nawigacja | Dwie listy rozmów i pięć równorzędnych zakładek; brak szybkiego przejścia | Agent jako centrum, narzędzia projektu w drugiej hierarchii, wspólna paleta działań |
| Ustawienia | Karty wewnątrz kart, różna gęstość i częściowo angielski tekst; trudne odnalezienie podstawowych opcji | Czytelne kategorie, opis przeznaczenia, startowe skróty konfiguracji i wyszukiwanie |
| Modale | Systemowe alert/prompt, brak konsekwentnego fokusu i błędów w miejscu | Jedna spokojna powierzchnia, etykiety, Enter/Escape, przywrócenie fokusu |
| Postęp | Techniczny log konkurował z rozmową | Utrzymanie zbiorczych szczegółów, widocznych pytań i decyzji, faktyczne komunikaty modelu |
| Stany puste | Brak projektu wygląda jak gotowość do pracy; przyciski bez czytelnego następnego kroku | Jawny wybór folderu i powiązane działania, brak operacji na nieokreślonym katalogu |

## Niespójności wizualne

Pozostałości obejmują barwne ikony typów plików, podwójny nagłówek ustawień, badge połączenia powtarzany w stopce, obramowane miniakcje sidebaru, zbyt długi tekst pomocniczy composera, ciężkie placeholdery plików/terminala, różne cienie i wysokości kontrolek. Kierunek: wspólne tokeny, neutralne ikony, jedna hierarchia, subtelne rozdzielenie powierzchni, brak ozdobnych animacji.

## Kryteria odbioru

Uruchomienie nowego i istniejącego projektu, błędna ścieżka bez utraty rozmowy, przełączanie projektów, lokalizacja i historia, wyszukiwanie, nowa rozmowa, wybór wielu plików i usuwanie kontekstu, podgląd/edycja/zapis/konflikt, model i uprawnienia, zapis/odrzucenie ustawień, terminal, przegląd rzeczywistych zmian, wąski układ oraz motyw jasny i ciemny. Build Windows musi przejść tę samą kontrolę po uruchomieniu z pliku `.exe`.

## Wykonana przebudowa

- Stały wybór projektu i wspólny menedżer: ścieżka ręczna, systemowy wybór folderu, istniejące projekty, pusty projekt i zamknięcie bieżącego folderu. Zmiana lokalizacji przepina historię oraz nazwę projektu; nie przenosi plików. Aktywne zadania blokują zmianę lokalizacji.
- Sidebar z nową rozmową, wyszukiwaniem projektów/rozmów oraz stałymi wejściami do projektów i ustawień. Paleta przeszukuje działania, projekty i pliki. Skróty działają także z wnętrza widoku agenta.
- Jawny wybór plików do kontekstu: wyszukiwanie, wielokrotny wybór, zaznaczenia i usuwanie. Istniejące wzmianki `@` pozostają kompatybilne. Nazwy ze spacjami i formatowanie wiadomości są zachowywane.
- Podgląd pliku ma akcje dodania do rozmowy i edycji. Edytor obsługuje UTF-8 do 1 MB, kontroluje rewizję pliku, zatrzymuje zapis przy konflikcie i chroni niezapisane zmiany przy nawigacji/zamykaniu. Zapis jest ograniczony do aktualnego projektu.
- Ustawienia mają wspólną hierarchię, płaskie sekcje, siedem kategorii i wyszukiwanie. Zamknięcie krzyżykiem/Escape respektuje bufor `cachedState`. Brak klucza API nie blokuje zapisu niezależnych ustawień. Kontrolki dotyczące kart VS Code i jego skrótów są pominięte w desktopie.
- Wspólne powierzchnie, neutralne ikony, spokojniejsze podglądy i diffy, jedna stopka sidebaru oraz jeden nagłówek ustawień. Synchronizacja jasnego motywu obejmuje także systemowe kontrolki.
- Widok agenta zachowuje rozmowę oraz prawdziwe komunikaty modelu jako główną treść. Szczegóły operacji są zwijane; pytania, wymagane decyzje i nierozwiązane błędy pozostają dostępne. Nie dodano modelu generującego fikcyjne podsumowania postępu.

## Kontrola działania

`scripts/test-product-runtime.mjs` sprawdza rzeczywiste otwieranie folderów, zachowanie projektu i draftu po błędzie ścieżki, blokadę zapisu poza projektem, kontekst ze spacjami, zapis pliku, konflikt z edycją na dysku, ochronę nawigacji, prawdziwy diff Git z polską nazwą, paletę wywołaną z composera, zapis/odrzucenie ustawień, zapis motywu bez API i stan bez projektu. Próba wysłania zadania bez folderu prowadzi do wyboru projektu przed zapytaniem do modelu.

Pozostałe kontrole uruchomione w Electron: `test-design-runtime.mjs`, `test-model-selector-runtime.mjs`, `test-agent-conversation-runtime.mjs` (jasny/ciemny) i `audit-interface-runtime.mjs` (siedem kategorii, pięć widoków, rozwijane panele, pięć palet). Fixture rozmowy korzysta z normalnego widoku React i nie wywołuje płatnych modeli.

Testy desktopowe obejmują także migrację lokalizacji z historią, blokadę przy aktywnych zadaniach, niepowodzenie zapisu i pozostawienie plików na dysku. Kontrola UI nie zastępuje testu połączenia z własnym kontem dostawcy: płatnych zapytań i zewnętrznego logowania nie wykonywano.

## Wynik odbioru — 18 października 2026

Pełny build zakończony powodzeniem. Kontrola typów desktopu i webview przeszła; 205 testów desktopowych (26 plików) i 276 testów UI (18 plików) zakończyło się powodzeniem. Zbiorczy runner akceptacyjny przeszedł wszystkie siedem etapów na uruchomionym pliku Windows portable. Sprawdzono również podgląd motywu bez zapisu, ochronę świeżo zapisanego motywu przed opóźnionym stanem silnika, skróty z fokusem w composerze i wspólne działania w widokach Agent/Czat.

Przygotowano NSIS i portable x64. Lokalny pakiet `Gotowa-aplikacja-Windows/Wersja-finalna` zawiera oba pliki, sumy SHA-256, `Raport-weryfikacji.json` oraz zrzuty z uruchomionej aplikacji. Testy działały na oddzielnym profilu `.design-qa`, bez zmiany projektów i danych użytkownika.
