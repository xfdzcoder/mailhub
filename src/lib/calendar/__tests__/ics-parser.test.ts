import { parseIcs, isCalendarAttachment } from '../ics-parser';

describe('ics-parser', () => {
  const sampleIcs = `BEGIN:VCALENDAR
METHOD:REQUEST
PRODID:Microsoft Exchange Server 2010
VERSION:2.0
BEGIN:VEVENT
ORGANIZER;CN=Robert McMillan:mailto:rmcmillan@oc-innovation.ca
ATTENDEE;ROLE=OPT-PARTICIPANT;CN=info@itcg.ca:mailto:info@itcg.ca
DESCRIPTION:Microsoft Teams meeting\\nJoin: https://teams.microsoft.com/meet/241318111466818
SUMMARY:Future Ready Discussion
DTSTART;TZID=Eastern Standard Time:20260729T150000
DTEND;TZID=Eastern Standard Time:20260729T153000
X-MICROSOFT-LOCATIONS:[ { "DisplayName" : "Microsoft Teams Meeting" } ]
END:VEVENT
END:VCALENDAR`;

  it('should identify calendar attachments correctly', () => {
    expect(isCalendarAttachment({ filename: 'invite.ics', contentType: 'text/calendar' })).toBe(true);
    expect(isCalendarAttachment({ filename: 'meeting.ICS', contentType: 'application/octet-stream' })).toBe(true);
    expect(isCalendarAttachment({ filename: 'document.pdf', contentType: 'application/pdf' })).toBe(false);
  });

  it('should parse iCalendar VEVENT data accurately', () => {
    const events = parseIcs(sampleIcs);
    expect(events).toHaveLength(1);

    const ev = events[0];
    expect(ev.summary).toBe('Future Ready Discussion');
    expect(ev.location).toBe('Microsoft Teams Meeting');
    expect(ev.organizerName).toBe('Robert McMillan');
    expect(ev.organizerEmail).toBe('rmcmillan@oc-innovation.ca');
    // Eastern Standard Time is UTC-4 in July; assert instants independently of the host timezone.
    expect(ev.startDate.toISOString()).toBe('2026-07-29T19:00:00.000Z');
    expect(ev.endDate.toISOString()).toBe('2026-07-29T19:30:00.000Z');
    expect(ev.meetingUrl).toBe('https://teams.microsoft.com/meet/241318111466818');
  });
});
